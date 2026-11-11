export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  isContextOverflowFailure,
  type ToolCall,
} from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import { Cause, Clock, Data, Deferred, Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
    readonly freshAssistant?: boolean
  }
  RecoverFull: {}
  Compacted: {}
  OutputLimit: { readonly needsContinuation: boolean }
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly isLocationClosed: () => boolean
  /** Why the execution is being interrupted, once it is: `"user"` when someone stopped it. */
  readonly interruption?: () => "user" | "shutdown" | undefined
  /** Whether this server is handing its process daemon over to the next one (see `PersistentPty.handoffPrepared`). */
  readonly handoffPrepared?: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  /** Set when this attempt runs because an earlier one in the step scheduled a retry. */
  readonly retryAttempt?: number
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
  /** Step-scoped so the stall watchdog counts silence that began in an earlier attempt. */
  readonly stall: { lastEventAt: number | undefined; attemptStartedAt: number | undefined }
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const
const DOOM_LOOP_THRESHOLD = 3
const DOOM_LOOP_MESSAGES = 16
const DOOM_LOOP_MARKER = { doomLoop: "warn" } as const
const DOOM_LOOP_STOP = "Doom loop repeated after warning. Stopping this turn."
const STALL_TIMEOUT_MS = 90 * 1000
const STALL_CHECK_INTERVAL_MS = 5 * 1000
// Silence before the first provider event is a slow time to first token, not a stalled stream:
// reasoning models can legitimately stay quiet for minutes. Generous, but finite, so a dead
// provider still fails the attempt instead of idling until the transport's idle timeout.
const TTFT_TIMEOUT_MS = 10 * 60 * 1000
const doomLoopWarning = (name: string) =>
  `Doom loop detected: the same ${name} tool call was repeated with identical input. Do not repeat it — change your approach, arguments, or use a different tool. The turn continues after this warning.`

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service
  const store = yield* SessionStore.Service
  const permission = yield* Permission.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started,
    // so it is captured while the provider request is in flight instead of delaying it.
    const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)
    const started = yield* Clock.currentTimeMillis
    let firstOutputAt: number | undefined
    const modelAttributes = {
      "gen_ai.provider.name": input.model.ref.providerID,
      "gen_ai.request.model": input.model.ref.id,
    }
    yield* Effect.annotateCurrentSpan({
      ...modelAttributes,
      "gen_ai.agent.name": input.agent,
      ...(input.retryAttempt === undefined ? {} : { "opencode.retry.attempt": input.retryAttempt }),
    })
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      pendingSnapshot: Fiber.join(pendingStartSnapshot),
      started,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
      readonly cancel: Cancel
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    // A prior deny strike is derived from the projected warning, so it survives retries and restarts.
    const doom = { blocked: false }
    const gateDoomLoop = Effect.fn("SessionStep.gateDoomLoop")(function* (call: ToolCall) {
      const messages = yield* store
        .messages({ sessionID: input.sessionID, order: "desc", limit: DOOM_LOOP_MESSAGES })
        .pipe(Effect.catchTag("Session.MessageDecodeError", () => Effect.succeed(undefined)))
      // Undecodable history must not fail tool calls; without history there is nothing to detect.
      if (messages === undefined) return
      const boundary = messages.findIndex((message) => message.type === "user")
      const content = messages
        .slice(0, boundary === -1 ? undefined : boundary)
        .reverse()
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
      if (!doomLoopDetected(content, call)) return
      const warned = doomLoopWarned(content)
      yield* permission
        .assert({
          action: "doom_loop",
          resources: [call.name],
          save: [call.name],
          metadata: { tool: call.name },
          sessionID: input.sessionID,
          agent: input.agent,
          source: { type: "tool", messageID: input.assistantMessageID, id: call.id },
        })
        .pipe(
          // Two strikes: deny warns the model and keeps the turn alive; a repeat stops the turn.
          Effect.catchTag("Permission.BlockedError", () =>
            Effect.gen(function* () {
              if (warned) {
                doom.blocked = true
                return yield* new Tool.Error({ message: DOOM_LOOP_STOP })
              }
              return yield* new Tool.Error({ message: doomLoopWarning(call.name), metadata: DOOM_LOOP_MARKER })
            }),
          ),
          // A rejection tunnels as a defect so tools cannot catch it; recover it here as the typed
          // decline SessionModelRequest.executeTool expects to classify.
          Effect.catchCauseFilter(
            (cause) => {
              const decline = cause.reasons.flatMap((r) =>
                Cause.isDieReason(r) && r.defect instanceof Permission.DeclinedError ? [r.defect] : [],
              )[0]
              return decline ? Result.succeed(decline) : Result.fail(cause)
            },
            (decline) => Effect.fail(decline),
          ),
          // Mirror the tool boundary: every other permission failure becomes a model-visible tool error.
          Effect.mapError((error) =>
            error instanceof Tool.Error || error instanceof Permission.DeclinedError
              ? error
              : new Tool.Error({ message: error instanceof globalThis.Error ? error.message : String(error) }),
          ),
        )
    })
    // A user's stop asks each tool awaiting `cancel` to stop and settle its own call, and interrupts every other
    // tool. A tool that does not settle in time is interrupted too. Teardown interrupts every tool.
    const stopTools = Effect.suspend(() => {
      // A reloaded Location still serves the steps that borrow it, so its tools can stop on their own too.
      const user = input.interruption?.() === "user"
      const immediate = toolRuns.flatMap((run) => (user && run.cancel.trigger() ? [] : [run.fiber]))
      return Fiber.interruptAll(immediate).pipe(
        Effect.andThen(Fiber.awaitAll(toolRuns.map((run) => run.fiber)).pipe(Effect.timeoutOption(COOPERATIVE_STOP))),
        Effect.flatMap((settled) => (Option.isSome(settled) ? Effect.void : interruptTools)),
      )
    })
    const executeTool = (call: ToolCall, cancel: Cancel) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return gateDoomLoop(call).pipe(
        Effect.andThen(
          input.prepared.executeTool({
            sessionID: input.sessionID,
            agent: input.agent,
            messageID: input.assistantMessageID,
            call,
            progress: (update) => publisher.progress(call.id, update),
            cancel: cancel.effect,
          }),
        ),
      )
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    // Read to the end, not just the finish event, so the next request can reuse this response.
    // The span covers only the provider stream, so model time separates from tools, which run in this consumer.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.withSpan("LLM.stream", { attributes: modelAttributes }),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          input.stall.lastEventAt = yield* Clock.currentTimeMillis
          if (publisher.record().providerFailed) return
          // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
          if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
          yield* publisher.publish(event)
          if (firstOutputAt === undefined && publisher.record().outputStarted)
            firstOutputAt = yield* Clock.currentTimeMillis
          if (event.type !== "tool-call" || event.providerExecuted) return
          const cancel = makeCancel()
          toolRuns.push({
            call: event,
            cancel,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event, cancel)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // The fork's stall watchdog: a provider stream that goes silent — no events, no error —
    // never fails on its own, so the step hangs until the user stops it. Silence while a tool
    // call is pending is a long local or hosted execution idling the stream by design, and does
    // not count. The failure shares the incomplete-stream classification, so recovery reuses the
    // established retry and continuation paths instead of the fork's TransientTurnError.
    const watchdog = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(STALL_CHECK_INTERVAL_MS)
        if (publisher.hasPendingTools()) continue
        // No event in this attempt yet: silence counts from the attempt start against the slower
        // TTFT budget. Once any event has arrived (in this or an earlier attempt), silence counts
        // from the last event against the tight stall budget, which also keeps a retry whose
        // predecessor went silent from paying the attempt budget again.
        const sawEvent = input.stall.lastEventAt !== undefined
        const base = input.stall.lastEventAt ?? input.stall.attemptStartedAt
        if (base === undefined) continue
        if ((yield* Clock.currentTimeMillis) - base >= (sawEvent ? STALL_TIMEOUT_MS : TTFT_TIMEOUT_MS))
          return yield* new AIError({
            reason: new InvalidProviderOutputError({
              message: "The provider response went silent without completing.",
              classification: "incomplete-stream",
            }),
          })
      }
    })

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        input.stall.attemptStartedAt = yield* Clock.currentTimeMillis
        const stream = yield* restore(Effect.raceFirst(providerStream, watchdog)).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
        if (
          Exit.isFailure(stream) &&
          streamInterrupted &&
          !publisher.hasStarted() &&
          !pendingStartSnapshot.pollUnsafe()
        )
          return yield* Effect.failCause(stream.cause)
        if (publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* stopTools
        const fibers = toolRuns.map((run) => run.fiber)
        const joined = yield* restore(Fiber.awaitAll(fibers)).pipe(Effect.exit)
        if (!streamInterrupted && Exit.isFailure(joined)) yield* stopTools
        // Read each tool's exit once all have ended, so what they raised while stopping (a decline, a defect) counts.
        const exits = Exit.isSuccess(joined) ? joined.value : yield* Fiber.awaitAll(fibers)
        const tools = classifyToolExits(exits, toolRuns, Exit.hasInterrupts(joined))
        // A server handing its process daemon over leaves the step as a crash would: unsettled calls and no step end.
        // The next server settles them when the Session resumes, and takes over the shell commands still running for
        // them. Any other interrupt settles the calls here.
        if (
          (streamInterrupted || tools.interrupted) &&
          tools.declines.length === 0 &&
          input.interruption?.() !== "user" &&
          input.handoffPrepared?.() === true
        )
          return yield* Effect.interrupt

        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(streamFailure) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: streamFailure?.message,
          })
          return Outcome.Compacted()
        }

        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        const tokens = recorded.finish?.usage
        yield* Effect.annotateCurrentSpan({
          ...(firstOutputAt === undefined ? {} : { "opencode.llm.first_output_ms": firstOutputAt - started }),
          ...(recorded.finish === undefined ? {} : { "gen_ai.response.finish_reasons": [recorded.finish.finish] }),
          ...(tokens?.inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": tokens.inputTokens }),
          ...(tokens?.outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": tokens.outputTokens }),
          ...(tokens?.cacheReadInputTokens === undefined
            ? {}
            : { "gen_ai.usage.cache_read.input_tokens": tokens.cacheReadInputTokens }),
          ...(tokens?.cacheWriteInputTokens === undefined
            ? {}
            : { "gen_ai.usage.cache_creation.input_tokens": tokens.cacheWriteInputTokens }),
          ...(llmFailure === undefined ? {} : { "error.type": llmFailure.reason._tag }),
        })
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // Parsers may leave unfinished calls without an execution event.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
          yield* publisher.failIncompleteTools()
        }

        const record = publisher.record()
        if (record.finish || record.failure) {
          const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
          // No local tool ran, so the step changed no files: its start tree is also its end tree.
          // Skip the second capture and diff, which serialize per repository.
          const snapshot = toolRuns.length === 0 ? startSnapshot : yield* snapshots.capture()
          const files =
            toolRuns.length === 0
              ? snapshot === undefined
                ? undefined
                : []
              : startSnapshot && snapshot
                ? startSnapshot === snapshot
                  ? []
                  : yield* snapshots
                      .files({ from: startSnapshot, to: snapshot })
                      .pipe(Effect.orElseSucceed(() => undefined))
                : undefined
          const usage = record.finish ? SessionUsage.record(record.finish.usage, input.model.cost) : undefined
          if (usage) yield* Effect.annotateCurrentSpan("opencode.usage.cost_usd", usage.cost)
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              native: record.finish.native,
              ...usage,
              snapshot,
              files,
            })
        }

        if (llmError && retry?.retry && tools.declines.length === 0 && !tools.interrupted)
          return Outcome.Retry({ error: llmError, decision: retry, freshAssistant: true })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        const needsContinuation =
          input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation && !doom.blocked
        if (record.finish?.finish === "length") return Outcome.OutputLimit({ needsContinuation })
        return Outcome.Completed({ needsContinuation })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

/**
 * The window the fork checked on the third tool-call event: the call being executed plus the two
 * preceding turn parts are identical tool calls with settled input. Anchoring on the executing call
 * keeps concurrent tool fibers from detecting each other's parts.
 */
const doomLoopDetected = (content: readonly SessionMessage.AssistantContent[], call: ToolCall) => {
  const self = content.findIndex((item) => item.type === "tool" && item.id === call.id)
  if (self < DOOM_LOOP_THRESHOLD - 1) return false
  const input = JSON.stringify(call.input)
  return content
    .slice(self - (DOOM_LOOP_THRESHOLD - 1), self + 1)
    .every(
      (item) =>
        item.type === "tool" &&
        item.state.status !== "streaming" &&
        item.name === call.name &&
        JSON.stringify(item.state.input) === input,
    )
}

/** A strike already happened in this turn when the projected warning carries its marker. */
const doomLoopWarned = (content: readonly SessionMessage.AssistantContent[]) =>
  content.some(
    (item) => item.type === "tool" && item.state.status === "error" && item.state.metadata?.doomLoop === "warn",
  )

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  exits: ReadonlyArray<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
  // The step was interrupted while it waited for its tools.
  interruptedWhileWaiting: boolean,
) => {
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: interruptedWhileWaiting || causes.some(Cause.hasInterrupts), declines, failure }
}

// How long a user's stop waits for the tools it asked to stop before interrupting them.
const COOPERATIVE_STOP = "5 seconds"

type Cancel = ReturnType<typeof makeCancel>

/**
 * A tool call's `cancel`. `trigger` completes it, and reports whether the tool was awaiting it, so would stop on its
 * own; a tool that was not is interrupted instead.
 */
export const makeCancel = () => {
  let listeners = 0
  let cancelled = false
  const gate = Deferred.makeUnsafe<void>()
  return {
    effect: Effect.suspend(() => {
      if (cancelled) return Effect.void
      listeners++
      return Deferred.await(gate).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            listeners--
          }),
        ),
      )
    }),
    trigger: () => {
      cancelled = true
      if (listeners === 0) return false
      Deferred.doneUnsafe(gate, Exit.void)
      return true
    },
  }
}
