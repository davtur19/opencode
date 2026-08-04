import { describe, expect } from "bun:test"
import { Effect, Exit, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import {
  SessionBootReconcile,
  QUESTION_ORPHAN_MESSAGE,
  GENERIC_ORPHAN_MESSAGE,
} from "@/session/boot-reconcile"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Question, NotFoundError } from "@/question"
import { QuestionID } from "@/question/schema"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([
  Session.node,
  SessionBootReconcile.node,
  SessionStatus.node,
  Question.node,
  SessionProjector.node,
  Database.node,
])
const it = testEffect(LayerNode.compile(root))

function assistantInfo(
  sid: SessionID,
  id: string,
  parentID: string,
  created = 0,
): SessionV1.Assistant {
  return {
    id: MessageID.make(id),
    sessionID: sid,
    role: "assistant",
    time: { created },
    parentID: MessageID.make(parentID),
    modelID: "test-model",
    providerID: "test",
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant
}

function toolPart(
  sid: SessionID,
  messageID: string,
  id: string,
  state: SessionV1.ToolPart["state"],
): SessionV1.ToolPart {
  return {
    id: PartID.make(id),
    sessionID: sid,
    messageID: MessageID.make(messageID),
    type: "tool",
    callID: "call_1",
    tool: "question",
    state,
  } as unknown as SessionV1.ToolPart
}

function runningQuestionPart(sid: SessionID, messageID: string, id: string): SessionV1.ToolPart {
  return toolPart(sid, messageID, id, {
    status: "running",
    input: { prompt: "Continue?" },
    metadata: {},
    time: { start: 0 },
  })
}

function pendingQuestionPart(sid: SessionID, messageID: string, id: string): SessionV1.ToolPart {
  return toolPart(sid, messageID, id, {
    status: "pending",
    input: { prompt: "Continue?" },
    raw: "{}",
  })
}

function completedPart(sid: SessionID, messageID: string, id: string): SessionV1.ToolPart {
  return toolPart(sid, messageID, id, {
    status: "completed",
    input: { prompt: "Continue?" },
    output: "ok",
    title: "question",
    metadata: {},
    time: { start: 0, end: 1 },
  })
}

describe("session.boot-reconcile", () => {
  it.instance("finalizes an orphaned assistant turn with an unfinished (running) tool part", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reconcile = yield* SessionBootReconcile.Service
      const status = yield* SessionStatus.Service

      const session = yield* sessions.create({ title: "boot reconcile running" })
      const sid = session.id
      const assistant = assistantInfo(sid, "msg_assistant", "msg_user")
      const part = runningQuestionPart(sid, "msg_assistant", "prt_question")

      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart(part)
      yield* sessions.flushNow(sid)

      // The orphaned state: last assistant turn is not finalized and holds a
      // tool part that never reached a terminal state.
      const before = yield* sessions.findMessage(sid, (msg) => msg.info.role === "assistant").pipe(Effect.orDie)
      expect(Option.isSome(before)).toBe(true)
      if (Option.isSome(before)) {
        expect(before.value.info.finish).toBeUndefined()
        const p = before.value.parts.find((x) => x.id === part.id)
        expect(p?.type).toBe("tool")
        if (p?.type === "tool") expect(p.state.status).toBe("running")
      }

      yield* reconcile.run()
      // updatePart is buffered; make the interrupted part durable before reading.
      yield* sessions.flushNow(sid)

      const after = yield* sessions.findMessage(sid, (msg) => msg.info.role === "assistant").pipe(Effect.orDie)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        const info = after.value.info
        expect(info.finish).toBe("error")
        expect(info.time.completed).toBeDefined()
        expect(info.error?.name).toBe("MessageAbortedError")
        expect((info.error as { data?: { message?: string } }).data?.message).toBe(QUESTION_ORPHAN_MESSAGE)
        const p = after.value.parts.find((x) => x.id === part.id)
        expect(p?.type).toBe("tool")
        if (p?.type === "tool") {
          expect(p.state.status).toBe("error")
          expect(p.state.metadata?.interrupted).toBe(true)
          expect((p.state as { error?: string }).error).toBe(QUESTION_ORPHAN_MESSAGE)
        }
      }

      // The session must not be left parked in a busy state.
      const current = yield* status.get(sid)
      expect(current.type).toBe("idle")

      // Idempotent: a second pass finds nothing left to finalize.
      yield* reconcile.run()
      const again = yield* sessions.findMessage(sid, (msg) => msg.info.role === "assistant").pipe(Effect.orDie)
      expect(Option.isSome(again)).toBe(true)
      if (Option.isSome(again)) expect(again.value.info.finish).toBe("error")
    }),
  )

  it.instance("finalizes an orphaned assistant turn whose question tool part is stuck pending", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reconcile = yield* SessionBootReconcile.Service

      const session = yield* sessions.create({ title: "boot reconcile pending" })
      const sid = session.id
      const assistant = assistantInfo(sid, "msg_assistant", "msg_user")

      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart(pendingQuestionPart(sid, "msg_assistant", "prt_question"))
      yield* sessions.flushNow(sid)

      yield* reconcile.run()
      yield* sessions.flushNow(sid)

      const after = yield* sessions.findMessage(sid, (msg) => msg.info.role === "assistant").pipe(Effect.orDie)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.info.finish).toBe("error")
        expect((after.value.info.error as { data?: { message?: string } }).data?.message).toBe(GENERIC_ORPHAN_MESSAGE)
        const p = after.value.parts.find((x) => x.id === PartID.make("prt_question"))
        expect(p?.type).toBe("tool")
        if (p?.type === "tool") expect(p.state.status).toBe("error")
      }
    }),
  )

  it.instance("leaves finalized/started-after-boot sessions untouched", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reconcile = yield* SessionBootReconcile.Service

      const session = yield* sessions.create({ title: "boot reconcile untouched" })
      const sid = session.id
      const assistant = {
        ...assistantInfo(sid, "msg_assistant", "msg_user"),
        time: { created: 0, completed: 2 },
        finish: "complete",
      }

      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart(completedPart(sid, "msg_assistant", "prt_completed"))
      yield* sessions.flushNow(sid)

      yield* reconcile.run()
      yield* sessions.flushNow(sid)

      const after = yield* sessions.findMessage(sid, (msg) => msg.info.role === "assistant").pipe(Effect.orDie)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        // Untouched: still marked complete, no error added, part still completed.
        expect(after.value.info.finish).toBe("complete")
        expect(after.value.info.error).toBeUndefined()
        const p = after.value.parts.find((x) => x.id === PartID.make("prt_completed"))
        expect(p?.type).toBe("tool")
        if (p?.type === "tool") expect(p.state.status).toBe("completed")
      }
    }),
  )

  it.instance("question reply for an unknown request yields a clear NotFoundError", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const error = yield* question
        .reply({ requestID: QuestionID.ascending(), answers: [] })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (err) => Effect.succeed(err)),
          Effect.match({ onSuccess: (err) => err, onFailure: () => undefined as unknown }),
        )
      expect(error).toBeDefined()
      if (error) {
        expect((error as NotFoundError)._tag).toBe("Question.NotFoundError")
        expect((error as NotFoundError).message).toContain("service restarted")
      }
    }),
  )

  it.instance("question reject for an unknown request yields a clear NotFoundError", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const error = yield* question
        .reject(QuestionID.ascending())
        .pipe(
          Effect.catchTag("Question.NotFoundError", (err) => Effect.succeed(err)),
          Effect.match({ onSuccess: (err) => err, onFailure: () => undefined as unknown }),
        )
      expect(error).toBeDefined()
      if (error) {
        expect((error as NotFoundError)._tag).toBe("Question.NotFoundError")
        expect((error as NotFoundError).message).toContain("service restarted")
      }
    }),
  )

  it.instance("session created after boot reconcile ran is not touched by a later run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reconcile = yield* SessionBootReconcile.Service

      // Boot-time pass runs once, detached. Simulate the post-boot window: the
      // reconcile effect is already done, then a new session starts a turn that
      // is legitimately still in progress (running tool part, not finalized).
      yield* reconcile.run()

      const session = yield* sessions.create({ title: "boot reconcile post-boot" })
      const sid = session.id
      // Created after the boot pass, so it must be invisible to reconciliation.
      yield* sessions.updateMessage(assistantInfo(sid, "msg_assistant", "msg_user", Date.now()))
      yield* sessions.updatePart(runningQuestionPart(sid, "msg_assistant", "prt_question"))
      yield* sessions.flushNow(sid)

      // A manual re-run is not part of the contract (the layer only runs once at
      // boot), but it must not tear down a turn that started after boot.
      yield* reconcile.run()
      yield* sessions.flushNow(sid)

      const after = yield* sessions.findMessage(sid, (msg) => msg.info.role === "assistant").pipe(Effect.orDie)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.info.finish).toBeUndefined()
        const p = after.value.parts.find((x) => x.id === PartID.make("prt_question"))
        expect(p?.type).toBe("tool")
        if (p?.type === "tool") expect(p.state.status).toBe("running")
      }
    }),
  )
})
