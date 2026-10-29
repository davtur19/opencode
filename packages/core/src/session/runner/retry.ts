export * as SessionRunnerRetry from "./retry.js"

import { AIError } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionError } from "@opencode/schema/session-error"
import { SESSION_ROTATION_LIMIT, sessionRotationEnabled } from "@opencode/util/cloud-proxy"
import { Clock, Duration, Effect } from "effect"
import { Bus } from "../../bus.js"
import { ModelRetry } from "../../model-retry.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEgress } from "../egress.js"
import { SessionEnvironmentStamp } from "../environment-stamp.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  /** No credential resolved: the request uses the opencode gateway's free (public) path. */
  readonly anonymous?: boolean | undefined
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/**
 * Retries one provider failure. `model` resolves the opencode gateway's transient flakes: its
 * intermittent 401 on anonymous public requests and its usage-limit or abuse blocks (402/403/429)
 * when the session-addressed proxy and its rotating wire alias can move the retry to another
 * egress. A 502 is a transient gateway refusal the proxy can retry on another egress; other 5xx
 * stay on the same egress and use the general retry schedule. Callers without a resolved model
 * keep the plain reason taxonomy so auxiliary requests never mask a real
 * credential or billing failure.
 */
export function isRetryable(
  error: AIError,
  model?: { readonly ref: Model.Ref; readonly anonymous?: boolean | undefined },
) {
  const override = error.reason.http?.headers["x-should-retry"]
  if (override === "true") return true
  if (override === "false") return false
  // A 502 is a transient gateway refusal even when a provider wraps it in a
  // reason the switch below would not retry; with the proxy it also moves the
  // retry to another egress.
  if (error.reason.http?.status === 502) return true
  switch (error.reason._tag) {
    case "RateLimit":
    case "ProviderInternal":
      return true
    // A WebSocket acknowledgment marks delivery accepted before model output may exist.
    // Read failures can still recover; the Step chooses retry versus continuation from durable output.
    case "Transport":
      return (
        error.reason.delivery !== "rejected" &&
        (error.reason.delivery !== "accepted" || error.reason.operation === "read")
      )
    case "InvalidProviderOutput":
      return error.reason.classification === "incomplete-stream"
    // Unrecognized failures retry: classification records affirmative
    // deterministic evidence, and transient failures are exactly the ones
    // that arrive in shapes no classifier anticipates.
    case "UnknownProvider":
      return true
    // The opencode gateway intermittently rejects public requests with
    // invalid_bearer_credential (~1-2%) even though the public bearer it was sent is valid.
    // Only an anonymous request — one with no real credential that could be wrong — absorbs
    // that flake as transient; a credentialed401 stays terminal so a revoked or mistyped key
    // is never masked by a retry.
    case "Authentication": {
      if (model?.ref.providerID !== Provider.ID.opencode || model.anonymous !== true) return false
      // A 403 from the free-tier gateway is the abuse gate, not a credential problem, and retrying
      // it only helps when the next request can leave from another address under another identity.
      // That is exactly what the session-addressed proxy and the rotating wire alias do; without
      // them the retry would hit the same egress and session again.
      if (error.reason.http?.status === 403) return sessionRotationEnabled()
      return error.reason.http?.status === 401
    }
    // A 402 from the opencode gateway is a transient free-tier quota flake on free models: the
    // same request succeeds moments later. A 429 with the gateway's quota shape is a free-usage
    // cap, and with the session-addressed proxy active the cap can follow the egress address, so
    // rotating the wire alias is the only way to move the retry to a fresh one. Without the proxy
    // the cap is terminal; other providers' quota rejections are real billing limits.
    case "QuotaExceeded":
      return (
        model?.ref.providerID === Provider.ID.opencode &&
        // Only the anonymous free path rotates: a credentialed opencode 429/402 is a real
        // account or subscription limit, and other providers' quota rejections are billing limits.
        model.anonymous === true &&
        (error.reason.http?.status === 402 ||
          (error.reason.http?.status === 429 && sessionRotationEnabled()))
      )
    case "ContentPolicy":
    case "InvalidRequest":
    case "UnsupportedOperation":
    case "NoRoute":
    case "Timeout":
      return false
    default: {
      const exhaustive: never = error.reason
      return exhaustive
    }
  }
}

/**
 * A transient step failure whose schedule runs out starts another fresh schedule phase instead of
 * finalizing the step: one initial policy plus renewals, each about 84s. This is the fork's
 * turn-level retry budget (TURN_RETRY_LIMIT), reworked per step because in V2 one step is one
 * logical LLM call; each renewal re-runs the failed call from scratch while the gateway heals.
 */
export const RETRY_PHASES = 4

// Gateway blocks that indicate a bad egress rotate the session's wire alias: the quota blocks on
// 402/429, the 403 abuse gate, and 502 gateway refusals. The next request must leave under a new
// identity and address. Rotation is bounded by the step allowance the proxy module grants; when
// the session-wide budget is spent, the policy renews the alias and environment stamp instead of
// surfacing the failure, so a long session keeps rotating automatically. SessionEgress.identity
// also refreshes an alias that reaches the gateway's timestamp window, so the first request after
// a long idle period does not need a rejection to get a usable identity. Other 5xx stay on the
// same egress and use the general retry schedule: the upstream, not the address, is usually the
// failing part.
const isEgressFailure = (error: AIError) =>
  error.reason.http?.status === 502 ||
  (error.reason._tag === "Authentication" && error.reason.http?.status === 403) ||
  error.reason._tag === "RateLimit" ||
  error.reason._tag === "QuotaExceeded"

export const policy = (sessionID: SessionSchema.ID, options?: { readonly phases?: number }) =>
  Effect.gen(function* () {
    const decide = yield* ModelRetry.policy(options?.phases ?? 1)
    let egressFailures = 0
    return (input: Input) =>
      Effect.gen(function* () {
        const next = yield* decide(input)
        if (!next) return { retry: false as const }
        // Only an anonymous free-tier request rotates its egress and wire alias. Every other
        // request (credentialed opencode, DeepSeek, Anthropic, ...) keeps the normal retry
        // schedule on the same address and the same real session identity.
        const egress =
          isEgressFailure(input.cause) &&
          input.model.providerID === Provider.ID.opencode &&
          input.anonymous === true &&
          sessionRotationEnabled()
        if (egress) egressFailures++
        const rotating = egress && egressFailures <= SESSION_ROTATION_LIMIT
        const allowed = next.retry && (!egress || rotating)
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: allowed ? { retry: true, delay: next.delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        if (rotating) {
          if (SessionEgress.canRotate(sessionID)) {
            const alias = SessionEgress.rotate(sessionID)
            yield* Effect.logDebug("session egress rotated", { sessionID, alias })
          } else {
            // The session budget is spent: renew the whole identity instead of letting a long
            // session stop rotating for good. `/resetid` remains the manual equivalent.
            const alias = SessionEgress.reset(sessionID)
            const environmentID = SessionEnvironmentStamp.reset(sessionID)
            yield* Effect.logDebug("session egress renewed", { sessionID, alias, environmentID })
          }
        }
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, { phases: RETRY_PHASES })
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
