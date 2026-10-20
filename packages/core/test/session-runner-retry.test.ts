import { afterEach, beforeEach, describe, expect } from "bun:test"
import {
  AIError,
  AuthenticationError,
  HttpContext,
  ProviderInternalError,
  RateLimitError,
  TransportError,
} from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionEgress } from "@opencode/core/session/egress"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Effect } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const http = (status: number) =>
  new HttpContext({ url: "https://opencode.ai/inference", status, headers: {} })
const blocked = new AIError({ reason: new AuthenticationError({ message: "blocked", http: http(403) }) })
const rateLimited = new AIError({ reason: new RateLimitError({ message: "slow down", http: http(429) }) })
const opencode = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.opencode })
const other = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("other") })

const env = {
  proxy: process.env.OPENCODE_CLOUD_PROXY,
  auth: process.env.OPENCODE_CLOUD_PROXY_AUTH,
}

beforeEach(() => {
  process.env.OPENCODE_CLOUD_PROXY = "http://proxy.invalid:8080"
  process.env.OPENCODE_CLOUD_PROXY_AUTH = "1"
  SessionEgress.clear()
})

afterEach(() => {
  if (env.proxy === undefined) delete process.env.OPENCODE_CLOUD_PROXY
  else process.env.OPENCODE_CLOUD_PROXY = env.proxy
  if (env.auth === undefined) delete process.env.OPENCODE_CLOUD_PROXY_AUTH
  else process.env.OPENCODE_CLOUD_PROXY_AUTH = env.auth
  SessionEgress.clear()
})

const inputFor = (cause: AIError, model: Model.Ref) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model,
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause, { ref: model, anonymous: true }),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(inputFor(cause, other))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("rotates the wire alias on an opencode 403 and stops at the step limit", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_retry_403")
      const policy = yield* SessionRunnerRetry.policy(sessionID)
      const aliases = [SessionEgress.identity(sessionID)]
      const results: boolean[] = []
      for (let i = 0; i < 5; i++) {
        results.push((yield* policy(inputFor(blocked, opencode))).retry)
        aliases.push(SessionEgress.identity(sessionID))
      }

      expect(results).toEqual([true, true, true, false, false])
      expect(new Set(aliases).size).toBe(4)
    }),
  )

  it.effect("rotates the wire alias on an opencode 429", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_retry_429")
      const policy = yield* SessionRunnerRetry.policy(sessionID)
      const aliases = [SessionEgress.identity(sessionID)]
      const results: boolean[] = []
      for (let i = 0; i < 5; i++) {
        results.push((yield* policy(inputFor(rateLimited, opencode))).retry)
        aliases.push(SessionEgress.identity(sessionID))
      }

      expect(results).toEqual([true, true, true, false, false])
      expect(new Set(aliases).size).toBe(4)
    }),
  )

  it.effect("leaves another provider's alias alone on a 429", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_retry_other_429")
      const alias = SessionEgress.identity(sessionID)
      const policy = yield* SessionRunnerRetry.policy(sessionID)
      const decision = yield* policy(inputFor(rateLimited, other))

      expect(decision.retry).toBe(true)
      expect(SessionEgress.identity(sessionID)).toBe(alias)
    }),
  )

  it.effect("stops rotating once the session budget is spent", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_retry_budget")
      for (let i = 0; i < SessionEgress.SESSION_EGRESS_BUDGET; i++) SessionEgress.rotate(sessionID)
      const alias = SessionEgress.identity(sessionID)
      const policy = yield* SessionRunnerRetry.policy(sessionID)
      const decision = yield* policy(inputFor(blocked, opencode))

      expect(decision.retry).toBe(false)
      expect(SessionEgress.identity(sessionID)).toBe(alias)
    }),
  )
})
