import { describe, expect } from "bun:test"
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
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

describe("Session.resetIdentity", () => {
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

  it.effect("fails for an unknown session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      expect(
        yield* sessions.resetIdentity(SessionSchema.ID.make("ses_missing")).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.NotFoundError" })
    }),
  )
})
