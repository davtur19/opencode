import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Duration, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import * as Cause from "effect/Cause"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
import { SessionRetry } from "./retry"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

function isEncryptedContentError(error: unknown): boolean {
  const str =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : ""
  if (/encrypted_content[`\s]+was not issued/i.test(str)) return true
  // NamedError (e.g. APIError) stores the descriptive message in data.message,
  // not in the Error.message field which is just the class name.
  if (error instanceof Error && "data" in error) {
    const data = (error as { data: unknown }).data
    if (data && typeof data === "object" && "message" in data) {
      const dataMsg = String((data as { message: unknown }).message)
      if (/encrypted_content was not issued/i.test(dataMsg)) return true
    }
  }
  if (error instanceof Error && error.cause) return isEncryptedContentError(error.cause)
  return false
}

/** Recursively remove all keys containing `encrypted_content` from any JSON-like value. */
function removeEncryptedContentKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = removeEncryptedContentKeys(value[i])
    }
    return value
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (key.includes("encrypted_content")) delete obj[key]
      else obj[key] = removeEncryptedContentKeys(obj[key])
    }
    return obj
  }
  return value
}

/** Deep-copy messages and remove encrypted_content from reasoning parts. */
function stripEncryptedFromModelMessages(msgs: ModelMessage[]): ModelMessage[] {
  const json = JSON.stringify(msgs)
  if (!json.includes("encrypted_content")) return msgs
  return removeEncryptedContentKeys(structuredClone(msgs)) as ModelMessage[]
}

function stripEncryptedFromReasoning(args: Record<string, unknown>): void {
  for (const field of ["prompt", "input"]) {
    const val = args[field]
    if (!val) continue
    const json = JSON.stringify(val)
    if (!json?.includes("encrypted_content")) continue
    args[field] = removeEncryptedContentKeys(structuredClone(val))
  }
  const po = args.providerOptions as Record<string, unknown> | undefined
  if (po) {
    for (const key of Object.keys(po)) {
      const v = po[key] as Record<string, unknown> | undefined
      if (v && typeof v === "object") {
        const cleaned = removeEncryptedContentKeys(structuredClone(v)) as Record<string, unknown>
        Object.assign(v, cleaned)
        if (Array.isArray(cleaned.include)) {
          const has = cleaned.include.some((x: unknown) => String(x).includes("encrypted_content"))
          if (has) {
            delete (v as Record<string, unknown>).include
          }
        }
      }
    }
  }
  if (Array.isArray(args.include)) {
    const hasEncrypted = args.include.some((v: unknown) => String(v).includes("encrypted_content"))
    if (hasEncrypted) {
      delete args.include
    }
  }
}

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      // Encrypted-content defense lives at the fetch boundary
      // (FetchProxy.sanitizeBody): the SDK rebuilds `input[].encrypted_content`
      // from conversation history after every strip point here, so stripping
      // locally is best-effort only.
      const streamMessages = stripEncryptedFromModelMessages(prepared.messages)
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: (() => {
            const po = ProviderTransform.providerOptions(input.model, prepared.params.options)
            // Unconditionally strip `include` arrays referencing encrypted_content.
            // The proxy gateway rejects these and the error recurs on every new
            // request — not just retries — so stripping only on retry is insufficient.
            if (po) {
              // Top-level include (e.g. po.include = ["reasoning.encrypted_content"])
              if (Array.isArray(po.include) && po.include.some((x: unknown) => String(x).includes("encrypted_content"))) {
                delete po.include
              }
              // Provider-specific sub-objects (e.g. po.openai.include)
              for (const key of Object.keys(po)) {
                const v = po[key]
                if (v && typeof v === "object" && !Array.isArray(v)) {
                  if (Array.isArray((v as Record<string, unknown>).include)) {
                    const inc = (v as Record<string, unknown>).include as unknown[]
                    if (inc.some((x: unknown) => String(x).includes("encrypted_content"))) {
                      delete (v as Record<string, unknown>).include
                    }
                  }
                }
              }
            }
            return po
          })(),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: streamMessages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                    stripEncryptedFromReasoning(args.params as Record<string, unknown>)
                    // The @ai-sdk/openai provider auto-adds
                    // `include: ["reasoning.encrypted_content"]` when store === false
                    // AND the model is a reasoning model (line ~5674 in its dist).
                    // This runs AFTER our middleware, so stripping include alone is
                    // insufficient — we must also neutralize the trigger condition.
                    const po = (args.params as Record<string, unknown>).providerOptions
                    if (po && typeof po === "object" && !Array.isArray(po)) {
                      const openai = (po as Record<string, unknown>).openai
                      if (openai && typeof openai === "object" && !Array.isArray(openai)) {
                        if ((openai as Record<string, unknown>).store === false) {
                          delete (openai as Record<string, unknown>).store
                        }
                      }
                      if ((po as Record<string, unknown>).store === false) {
                        delete (po as Record<string, unknown>).store
                      }
                    }
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const makeStream = Effect.fn("LLM.makeStream")(function* () {
              const result = yield* run({ ...input, abort: ctrl.signal })
              if (result.type === "native") return { type: "native" as const, stream: result.stream }
              const state = LLMAISDK.adapterState()
              return {
                type: "ai-sdk" as const,
                stream: Stream.fromAsyncIterable(result.result.fullStream, (e) =>
                  e instanceof Error ? e : new Error(String(e)),
                ).pipe(
                  Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                  Stream.flatMap((events) => Stream.fromIterable(events)),
                ),
              }
            })

            const first = yield* makeStream()
            if (first.type === "native") return first.stream

            // Stream-level safety net for failures the processor's retry
            // policy cannot see: it only retries failures that surface as a
            // parsed APIError through its own `parse`. Anything else — a raw
            // Error, a NamedError.Unknown wrapping a response.failed envelope,
            // a defect from streamText construction — skips stream-level AND
            // turn-level retry entirely and lands on the message as a terminal
            // error. Retry those here, from scratch, before handing the stream
            // to the processor: one immediate retry, one after a cooldown.
            // Non-retryable failures skip both and fail fast.
            const SAFETY_NET_COOLDOWN_MS = 10_000
            let attempts = 0
            const safetyNet = (cause: Cause.Cause<unknown>): Stream.Stream<LLMEvent, unknown> => {
              if (attempts >= 2) return Stream.failCause(cause)
              const squashed = Cause.squash(cause)
              if (isEncryptedContentError(squashed)) {
                attempts += 1
                return Stream.unwrap(
                  Effect.gen(function* () {
                    const retry = yield* makeStream()
                    return retry.stream
                  }),
                )
              }
              const parsed = MessageV2.fromError(squashed, { providerID: input.model.providerID })
              const retry = SessionRetry.retryable(parsed, input.model.providerID)
              if (!retry) return Stream.failCause(cause)
              attempts += 1
              const wait = attempts === 2 ? SAFETY_NET_COOLDOWN_MS : 0
              return Stream.unwrap(
                Effect.gen(function* () {
                  yield* Effect.logInfo("llm stream safety-net retry", {
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                    "session.id": input.sessionID,
                    attempt: attempts,
                    cooldownMs: wait,
                    message: retry.message,
                  })
                  if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
                  const retriedStream = yield* makeStream()
                  return retriedStream.stream.pipe(Stream.catchCause(safetyNet))
                }),
              )
            }
            return first.stream.pipe(Stream.catchCause(safetyNet))
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"
