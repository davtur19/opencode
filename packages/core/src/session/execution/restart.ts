export * as SessionRestart from "./restart.js"

import { Context, Effect, Layer } from "effect"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../../bus.js"
import { Database } from "../../database/database.js"
import { Job } from "../../job.js"
import { Session } from "../../session.js"
import { SessionEvent } from "../event.js"
import { SessionExecution } from "../execution.js"
import { SessionHistory } from "../history.js"
import type { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable, SessionTable } from "../sql.js"
import { ShellResult } from "../../shell/result.js"
import { SubagentCompletion } from "../subagent-completion.js"

const CONTINUE_AFTER_SERVER_RESTART =
  "The server restarted while you were working. Continue from where you left off without repeating completed work."

const RESUME_EXHAUSTED = {
  type: "aborted",
  message: "Execution was interrupted repeatedly and will not be resumed automatically.",
} as const

// A `question` tool awaiting user input dies with the in-memory Form: no reply can
// ever arrive, so its part must not park the transcript on a spinner after restart.
export const QUESTION_ORPHAN_MESSAGE = "Service restarted while awaiting user input (orphaned question tool)"
// Any other pre-boot turn cut short by a crash that never resumes: finalize it so the
// session doesn't stay parked.
export const GENERIC_ORPHAN_MESSAGE = "Service restarted while turn was in progress (orphaned turn)"

export interface Options {
  /**
   * Times a single turn may be resumed before it is terminalized instead.
   * The counter is durable and only a terminal event resets it, so a turn
   * that keeps dying cannot crash-loop across restarts. Turns that complete
   * never accumulate: the budget is per-turn, not per-session.
   */
  readonly maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 10

export interface Interface {
  /**
   * Resumes Sessions whose execution claim was never released — turns orphaned
   * by a process that died without teardown, or interrupted by a graceful
   * shutdown (which preserves the claim on purpose). The claim is never
   * cleared here: only a terminal event releases it, so a death anywhere in
   * the resume path leaves the same orphaned claim for the next boot.
   */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/**
 * Recovery for orphaned executions. Claims are written at turn start by
 * SessionExecution, so this sweep needs no cooperation from the previous
 * process: crash, SIGKILL, isolate eviction, and graceful restart all leave
 * the same durable signature.
 *
 * Recovery is at-least-once: local coordination prevents concurrent drains,
 * not repeated external side effects after a crash.
 *
 * The sweep assumes every orphaned claim's owner is dead. The managed-server
 * protocol guarantees this: a successor is only spawned after the previous
 * process is confirmed dead (client service `kill`/`evict` poll the PID), the
 * registration lock admits one managed server at a time, and unregistered
 * servers sharing the database never sweep. The service is inert until called
 * — the managed server invokes it at boot; embedders may call it from their
 * own start-up.
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRestart") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const execution = yield* SessionExecution.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const db = (yield* Database.Service).db
      const scope = yield* Effect.scope
      const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
      // The boot instant, captured once when the layer is constructed. Anything
      // created after this point belongs to post-boot activity and is never
      // touched, even if a sweep overlaps live work.
      const bootTime = Date.now()

      const prepareResume = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        // Durable before the resume runs, so a crash inside the resumed turn is
        // counted by the next sweep and the budget cannot be dodged.
        const attempts = yield* store.countResume(sessionID)
        if (attempts === undefined) return false
        if (attempts > maxAttempts) {
          // Terminalize instead: the release hook clears the claim and resets the
          // counter atomically with the terminal event.
          yield* bus.publish(
            SessionEvent.Execution.Failed,
            { sessionID, error: RESUME_EXHAUSTED },
            { commit: () => store.release(sessionID) },
          )
          return false
        }
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID,
          text: CONTINUE_AFTER_SERVER_RESTART,
          description: "Continuing after restart",
          metadata: { notice: "restart" },
        })
        return true
      })

      const recoverShell = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "shell" }>,
      ) {
        const state = background.status === "running" ? "cancelled" : background.status
        const text =
          background.status === "running"
            ? "Command cancelled because the server restarted"
            : state === "completed"
              ? (background.output ?? "Command completed")
              : state === "error"
                ? (background.error ?? "Command failed")
                : "Command cancelled"

        yield* sessions
          .synthetic({
            id: background.notificationID,
            sessionID: recovery.sessionID,
            description: recovery.command,
            ...ShellResult.notification({
              jobID: background.id,
              shellID: recovery.shellID,
              command: recovery.command,
              state,
              text,
            }),
            // Restart notices must not revive idle owners of long-lived shells.
            // Interrupted executions resume separately after their notices are admitted.
            resume: false,
          })
          .pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
            Effect.orDie,
          )
        yield* jobs.completeBackground(background.notificationID)
      })

      const recoverSubagent = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "subagent" }>,
        suspended: ReadonlySet<SessionSchema.ID>,
      ) {
        const child = yield* store.get(recovery.childSessionID)
        if (!child || child.parentID !== recovery.parentSessionID || !(yield* store.get(recovery.parentSessionID))) {
          yield* jobs.completeBackground(background.notificationID)
          return
        }

        const notify = Effect.fnUntraced(function* (result: Pick<Job.Background, "status" | "output" | "error">) {
          yield* SubagentCompletion.deliver(sessions, jobs, {
            ...result,
            recovery,
            notificationID: background.notificationID,
            resume: suspended.has(recovery.parentSessionID) ? false : undefined,
          }).pipe(Effect.orDie)
        })

        if (background.status !== "running") {
          yield* notify(background)
          return
        }
        if (yield* execution.isActive(recovery.childSessionID)) return
        if (!(yield* prepareResume(recovery.childSessionID))) {
          yield* notify({ status: "error", error: RESUME_EXHAUSTED.message })
          return
        }

        yield* jobs.start({
          id: background.id,
          type: "subagent",
          title: recovery.description,
          notificationID: background.notificationID,
          recovery,
          run: execution.resume(recovery.childSessionID).pipe(
            Effect.andThen(store.context(recovery.childSessionID)),
            Effect.map((messages) => {
              const assistant = messages.findLast(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }),
          ),
        })
        yield* jobs.background(background.id)
        yield* jobs.wait({ id: background.id }).pipe(
          Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
          Effect.forkIn(scope),
        )
      })

      /**
       * Settles pre-boot turns whose Sessions will never drain again:
       * releaseChildClaims clears orphaned child claims and resume exhaustion
       * terminalizes top-level turns, so their stale tool calls — an awaiting
       * `question` above all — and unfinished assistant messages would otherwise
       * dangle forever: a drain is what settles them, and these Sessions get
       * none. Claimed Sessions are skipped because their resumed drain owns
       * settlement.
       */
      const settleOrphanedTurns = Effect.fn("SessionRestart.settleOrphanedTurns")(function* () {
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.type, "assistant"),
              // Cut short before its terminal step boundary, or still holding tool
              // parts that never settled.
              sql`${SessionMessageTable.time_created} < ${bootTime}
                and (json_extract(${SessionMessageTable.data}, '$.time.completed') is null
                  or exists (select 1 from json_each(json_extract(${SessionMessageTable.data}, '$.content'))
                    where json_extract(value, '$.type') = 'tool'
                      and json_extract(value, '$.state.status') in ('running', 'streaming')))`,
            ),
          )
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return
        const claimed = new Set(
          (
            yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(isNotNull(SessionTable.time_suspended))
              .all()
              .pipe(Effect.orDie)
          ).map((session) => session.id),
        )
        for (const row of rows) {
          if (claimed.has(row.session_id)) continue
          const message = yield* SessionHistory.decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
          if (message?.type !== "assistant") continue
          const unfinished = message.content.filter(
            (item): item is SessionMessage.AssistantTool =>
              item.type === "tool" && (item.state.status === "running" || item.state.status === "streaming"),
          )
          const finalized = Boolean(message.time.completed || message.error || message.finish)
          if (unfinished.length === 0 && finalized) continue
          // A `question` stuck awaiting input gets the specific note; any other
          // unfinished part uses the generic orphan note.
          const runningQuestion = unfinished.find((tool) => tool.name === "question" && tool.state.status === "running")
          const note = runningQuestion ? QUESTION_ORPHAN_MESSAGE : GENERIC_ORPHAN_MESSAGE
          for (const tool of unfinished) {
            const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
            yield* bus.publish(SessionEvent.Tool.Failed, {
              sessionID: row.session_id,
              assistantMessageID: message.id,
              id: tool.id,
              error: { type: "aborted", message: note },
              ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
              executed: tool.executed === true,
            })
          }
          if (!finalized) {
            yield* bus.publish(SessionEvent.Step.Failed, {
              sessionID: row.session_id,
              assistantMessageID: message.id,
              error: { type: "aborted", message: GENERIC_ORPHAN_MESSAGE },
            })
          }
        }
      })

      return Service.of({
        resumeSuspendedSessions: Effect.gen(function* () {
          const active = yield* execution.active
          const pending = yield* jobs.pendingBackground
          const children = pending.flatMap((background) =>
            background.status === "running" && background.recovery.kind === "subagent"
              ? [background.recovery.childSessionID]
              : [],
          )
          // Early notices wait for recovery's accounting, including Sessions that exhaust their budget.
          const suspended = new Set(
            [...(yield* store.listSuspended()), ...children].filter((sessionID) => !active.has(sessionID)),
          )
          yield* store.releaseChildClaims(children)
          yield* Effect.forEach(
            // Admit shell outcomes before a recovered child can start its first model request.
            pending.toSorted((a, b) => Number(a.recovery.kind === "subagent") - Number(b.recovery.kind === "subagent")),
            Effect.fnUntraced(function* (background) {
              if ((yield* jobs.get(background.id))?.status === "running") return
              const recovery = background.recovery
              yield* recovery.kind === "shell"
                ? recoverShell(background, recovery)
                : recoverSubagent(background, recovery, suspended)
            }),
            { discard: true },
          )

          // Background completion can wake a parent, so inspect local ownership only after recovery.
          const resumed = yield* execution.active
          yield* Effect.forEach(
            (yield* store.listSuspended()).filter((sessionID) => !resumed.has(sessionID)),
            (sessionID) =>
              execution
                .resume(sessionID)
                .pipe(Effect.ignore, Effect.forkIn(scope), Effect.when(prepareResume(sessionID))),
            { concurrency: "unbounded", discard: true },
          )
          // Async observers consult this set at delivery; later completions wake parents normally.
          suspended.clear()
          // Resume decisions above left either a claim — the resumed drain settles its
          // own stale tool calls — or an orphan that never drains again: settle those.
          yield* settleOrphanedTurns()
        }),
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [SessionStore.node, SessionExecution.node, Bus.node, Job.node, Session.node, Database.node],
})
