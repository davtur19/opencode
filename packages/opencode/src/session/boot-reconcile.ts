import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { isRecord } from "@/util/record"
import { Session } from "./session"
import { SessionID } from "./schema"

// The in-memory `Question` pending map dies with the process. A `question` tool
// that was awaiting user input (status "running") when the service was SIGKILLed
// is therefore unreachable after a restart: no reply can ever arrive, and without
// reconciliation the session would sit parked with a running tool part forever.
export const QUESTION_ORPHAN_MESSAGE = "Service restarted while awaiting user input (orphaned question tool)"
// Any other assistant turn that never reached a terminal state (no completed,
// no finish, no error) was cut short by a crash/restart. Finalize it so the
// session doesn't stay parked.
export const GENERIC_ORPHAN_MESSAGE = "Service restarted while turn was in progress (orphaned turn)"
// A background `task` tool call whose child session finished (or died) without
// its result ever reaching the parent. The in-memory BackgroundJob registry is
// wiped by the restart, so the notify fiber that would have injected the result
// is gone for good.
export const BACKGROUND_TASK_ORPHAN_MESSAGE =
  "Background subagent result lost due to service restart (orphaned background task)"

// A tool part that never reached a terminal state is evidence of a turn cut
// short by a crash/restart. Once the service restarts the in-memory pending map
// is gone, so such a part would otherwise dangle in the DB forever and park the
// session.
function isUnfinishedTool(part: SessionV1.Part): part is SessionV1.ToolPart {
  return part.type === "tool" && (part.state.status === "running" || part.state.status === "pending")
}

// A background `task` tool call returns immediately with a "running"
// placeholder while the real work continues in the child session. If the
// service restarts before the notify fiber injects the result, the in-memory
// BackgroundJob registry is wiped and the placeholder stays in the parent
// transcript forever: the orchestrator keeps reading "you will be notified"
// for a task that already finished (or died). That placeholder — a completed
// tool part whose output still carries the running wrapper — is the orphan
// signature. Parts for tasks launched after boot are live work and are left
// alone (same bootTime guard as the turn pass above).
type CompletedTaskPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
function isOrphanedBackgroundTask(part: SessionV1.Part): part is CompletedTaskPart {
  if (part.type !== "tool" || part.tool !== "task" || part.state.status !== "completed") return false
  const meta = part.state.metadata
  if (!isRecord(meta) || meta["background"] !== true) return false
  if (typeof meta["sessionId"] !== "string") return false
  return part.state.output.startsWith("<task id=") && part.state.output.includes('state="running"')
}

// Mirror TaskTool.runTask's error extraction so the parent records the same
// message the subagent turn failed with.
function childFailureText(info: SessionV1.Assistant): string {
  const data = isRecord(info.error) ? info.error["data"] : undefined
  if (isRecord(data) && typeof data["message"] === "string") return data["message"]
  if (isRecord(info.error) && typeof info.error["name"] === "string") return info.error["name"]
  return "unknown error"
}

// Mirror the interrupted-tool cleanup that the processor's interrupt path does
// on SIGINT: status -> "error" with the orphan note as the tool error, so a
// following prompt does not read the block as still-pending work.
function interruptTool(part: SessionV1.ToolPart, error: string): SessionV1.ToolPart {
  const end = Date.now()
  const start = "time" in part.state ? part.state.time.start : end
  return {
    ...part,
    state: {
      status: "error",
      input: part.state.input,
      error,
      metadata: { ...("metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}), interrupted: true },
      time: { start, end },
    },
  }
}

export interface Interface {
  readonly run: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionBootReconcile") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const question = yield* Question.Service

    // The boot instant, captured once when the layer is constructed. Anything
    // created after this point belongs to post-boot activity and must never be
    // touched, even if a later manual run() overlaps it.
    const bootTime = Date.now()

    // Drop any in-memory Question pending entry still associated with an
    // orphaned `question` tool part. Runs at boot against a freshly-started
    // process, where the pending map is empty and this is a defensive no-op; it
    // only matters if run() is invoked with live pending questions (then the
    // block's deferred resolves with a rejection instead of dangling forever).
    const drainOrphanedQuestion = Effect.fn("SessionBootReconcile.drainOrphanedQuestion")(function* (part: SessionV1.ToolPart) {
      const pending = yield* question.list()
      for (const req of pending) {
        if (req.sessionID !== part.sessionID) continue
        if (req.tool?.callID !== part.callID || req.tool?.messageID !== part.messageID) continue
        yield* question.reject(req.id).pipe(Effect.ignore)
      }
    })

    // Finalize every session whose last assistant turn never reached a terminal
    // state (SIGKILL/restart mid-turn, or a `question` tool left `running` with
    // no in-memory pending map to reply to). Uses the message-store API
    // (updateMessage/updatePart) — never raw SQL. Idempotent: a turn that is
    // already finalized (completed/error/finish) with no unfinished tool parts
    // is left untouched, so a second boot finds nothing to do. Runs before the
    // background-task pass below so child sessions are settled before parents
    // read their final state.
    const run = Effect.fn("SessionBootReconcile.run")(function* () {
      let fixed = 0
      // listGlobal is capped at 100 by default; pull a generous window instead
      // of paginating so every session is visited (best-effort, detached at boot).
      const allSessions = yield* sessions.listGlobal({ limit: 100_000 })
      for (const sessionInfo of allSessions) {
        const sessionID = sessionInfo.id
        const match = yield* sessions.findMessage(sessionID, (msg) => msg.info.role === "assistant").pipe(
          // A session removed between listGlobal and this read is not an orphan;
          // skip it instead of aborting the whole pass.
          Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none<SessionV1.WithParts>())),
        )
        if (Option.isNone(match)) continue
        const messageInfo = match.value.info
        if (messageInfo.role !== "assistant") continue
        // A turn that started after boot belongs to post-boot activity, not to a
        // crashed pre-boot turn: leave it alone (guards the async window where
        // the detached pass overlaps live prompts).
        if (messageInfo.time.created > bootTime) continue
        const unfinished = match.value.parts.filter(isUnfinishedTool)
        const finalized = Boolean(messageInfo.time.completed || messageInfo.error || messageInfo.finish)
        if (unfinished.length === 0 && finalized) continue

        // A `question` tool stuck in "running" is a distinct orphan: it was
        // awaiting user input, so give it the specific note and drop its pending
        // entry. Any other in-flight state uses the generic orphan note.
        const runningQuestion = unfinished.find((p) => p.tool === "question" && p.state.status === "running")
        const note = runningQuestion ? QUESTION_ORPHAN_MESSAGE : GENERIC_ORPHAN_MESSAGE

        for (const part of unfinished) {
          yield* sessions.updatePart(interruptTool(part, note))
        }
        if (runningQuestion) {
          yield* drainOrphanedQuestion(runningQuestion)
        }

        if (!finalized) {
          const error = new SessionV1.AbortedError({ message: note }).toObject()
          messageInfo.error = error
          messageInfo.finish = "error"
          messageInfo.time.completed = Date.now()
          yield* sessions.updateMessage(messageInfo)
          yield* events.publish(Session.Event.Error, { sessionID, error })
        }
        // updatePart is coalesced/buffered; flush so the interrupted parts become
        // durable before the pass returns (updateMessage is already durable).
        yield* sessions.flushNow(sessionID)
        fixed += 1
      }
      if (fixed > 0) {
        yield* Effect.logWarning("boot reconciliation finalized orphaned assistant turns", { fixed })
      }
      const recovered = yield* reconcileBackgroundTasks()
      if (recovered > 0) {
        yield* Effect.logWarning("boot reconciliation recovered orphaned background tasks", { recovered })
      }
    })

    // Recover background `task` tool parts whose child session settled (or
    // vanished) without the result ever reaching the parent: with the
    // process-local BackgroundJob registry gone, no notify fiber can fire
    // anymore, so the parent transcript would otherwise keep the stale
    // "running" placeholder forever. A recovered child output is written back
    // onto the tool part (same shape as a foreground-completed task call); a
    // lost child is recorded as a part error so the orchestrator sees the
    // failure instead of waiting indefinitely. Idempotent: a recovered part no
    // longer carries the running placeholder, so a second boot finds nothing.
    const reconcileBackgroundTasks = Effect.fn("SessionBootReconcile.reconcileBackgroundTasks")(function* () {
      let recovered = 0
      const allSessions = yield* sessions.listGlobal({ limit: 100_000 })
      for (const sessionInfo of allSessions) {
        const sessionID = sessionInfo.id
        const msgs = yield* sessions.messages({ sessionID }).pipe(
          Effect.catchTag("NotFoundError", () => Effect.succeed([] as SessionV1.WithParts[])),
        )
        let touched = false
        for (const msg of msgs) {
          if (msg.info.role !== "assistant") continue
          if (msg.info.time.created > bootTime) continue
          for (const part of msg.parts.filter(isOrphanedBackgroundTask)) {
            const childID = part.state.metadata["sessionId"] as string
            // Only pre-boot child turns can fulfill this part: anything newer
            // belongs to a post-boot task_id resume, which reports through its
            // own fresh tool part.
            const child = yield* sessions
              .findMessage(
                SessionID.make(childID),
                (m) => m.info.role === "assistant" && m.info.time.created <= bootTime && Boolean(m.info.time.completed),
              )
              .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none<SessionV1.WithParts>())))
            if (Option.isSome(child) && child.value.info.role === "assistant" && !child.value.info.error) {
              const texts = child.value.parts.filter(
                (p): p is SessionV1.TextPart => p.type === "text" && !p.synthetic,
              )
              const output = texts.at(-1)?.text ?? ""
              yield* sessions.updatePart({
                ...part,
                state: {
                  status: "completed",
                  input: part.state.input,
                  output: `${output}\n\n<task id="${childID}" state="completed" />`,
                  title: part.state.title,
                  metadata: part.state.metadata,
                  time: { start: part.state.time.start, end: Date.now() },
                },
              } satisfies SessionV1.ToolPart)
            } else {
              const detail =
                Option.isNone(child) || child.value.info.role !== "assistant"
                  ? "child session not found"
                  : childFailureText(child.value.info)
              yield* sessions.updatePart({
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: `${BACKGROUND_TASK_ORPHAN_MESSAGE}: ${detail}`,
                  metadata: part.state.metadata,
                  time: { start: part.state.time.start, end: Date.now() },
                },
              } satisfies SessionV1.ToolPart)
            }
            touched = true
            recovered += 1
          }
        }
        if (touched) yield* sessions.flushNow(sessionID)
      }
      return recovered
    })

    // Run exactly once per process boot, detached, so listening is never blocked.
    yield* Effect.forkDetach(
      run().pipe(
        Effect.catchCause((cause) => Effect.logWarning("boot reconciliation failed", { cause })),
      ),
    )

    return Service.of({ run })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, EventV2Bridge.node, Question.node],
})

export * as SessionBootReconcile from "./boot-reconcile"