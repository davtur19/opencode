import { beforeEach, describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEgress } from "@opencode/core/session/egress"
import { SessionEnvironmentStamp } from "@opencode/core/session/environment-stamp"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const closed: SessionSchema.ID[] = []
let active: SessionSchema.ID | undefined

const transport = SessionModelTransport.Service.of({
  bind: () => {
    throw new Error("SessionModelTransport.bind is not used in this test")
  },
  close: (sessionID) => Effect.sync(() => closed.push(sessionID)),
  closeAll: Effect.void,
})

const execution = SessionExecution.Service.of({
  active: Effect.sync(() => new Set(active ? [active] : [])),
  isActive: (sessionID) => Effect.sync(() => sessionID === active),
  resume: () => Effect.void,
  wake: () => Effect.void,
  interrupt: () => Effect.succeed(false),
  awaitIdle: () => Effect.void,
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(Layer.succeed(SessionExecution.Service, execution)),
      SessionModelTransport.node.replace(Layer.succeed(SessionModelTransport.Service, transport)),
    ],
  ),
)

describe("Session.resetIdentity", () => {
  beforeEach(() => {
    closed.length = 0
    active = undefined
  })

  it.effect("rotates the provider identity without changing the session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const created = yield* sessions.create({ location })
      const alias = SessionEgress.identity(created.id)
      const environment = SessionEnvironmentStamp.id(created.id)

      const reset = yield* sessions.resetIdentity(created.id)

      expect(reset.environmentID).not.toBe(environment)
      expect(SessionEnvironmentStamp.id(created.id)).toBe(reset.environmentID)
      expect(SessionEgress.identity(created.id)).not.toBe(alias)
      expect(yield* sessions.get(created.id)).toMatchObject({ id: created.id })
      expect(yield* sessions.context(created.id)).toEqual([])
    }),
  )

  it.effect("closes an idle session transport so the next step reconnects", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const created = yield* sessions.create({ location })

      yield* sessions.resetIdentity(created.id)

      expect(closed).toEqual([created.id])
    }),
  )

  it.effect("keeps an active turn's transport open", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const created = yield* sessions.create({ location })
      const alias = SessionEgress.identity(created.id)
      active = created.id

      const reset = yield* sessions.resetIdentity(created.id)

      expect(closed).toEqual([])
      expect(SessionEgress.identity(created.id)).not.toBe(alias)
      expect(reset.environmentID).toBe(SessionEnvironmentStamp.id(created.id))
    }),
  )

  it.effect("fails for an unknown session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      expect(
        yield* sessions.resetIdentity(SessionSchema.ID.make("ses_missing")).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.NotFoundError" })
    }),
  )
})
