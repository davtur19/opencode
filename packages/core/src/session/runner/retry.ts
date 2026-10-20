export * as SessionRunnerRetry from "./retry.js"

import { AIError } from "@opencode/ai"
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
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
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
 * intermittent401 on anonymous public requests, its free-tier402 quota blip, and its 403/429 abuse
 * gate when the session-addressed proxy and its rotating wire alias can move the retry to another
 * egress. A 5xx stays on the same egress and uses the general retry schedule. Callers without a
 * resolved model keep the plain reason taxonomy so auxiliary requests never mask a real credential
 * or billing failure.
 */
export function isRetryable(
  error: AIError,
  model?: { readonly ref: Model.Ref; readonly anonymous?: boolean | undefined },
) {
  const override = error.reason.http?.headers["x-should-retry"]
  if (override === "true") return true
  if (override === "false") return false
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
    // A402 from the opencode gateway is a transient free-tier quota flake on free models: the
    // same request succeeds moments later. Other providers' quota rejections are real billing
    // limits and stay terminal.
    case "QuotaExceeded":
      return model?.ref.providerID === Provider.ID.opencode && error.reason.http?.status === 402
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

// Only a gateway 403/429 rotates the session's wire alias: the next request must leave under a new
// identity and address. Rotation is bounded by the step allowance the proxy module grants and by
// the session-wide budget in SessionEgress. A 5xx stays on the same egress and uses the general
// retry schedule: the upstream, not the address, is usually the failing part.
const isEgressFailure = (error: AIError) =>
  (error.reason._tag === "Authentication" && error.reason.http?.status === 403) ||
  (error.reason._tag === "RateLimit" && error.reason.http?.status === 429)

export const policy = (sessionID: SessionSchema.ID, options?: { readonly phases?: number }) =>
  Effect.gen(function* () {
    const decide = yield* ModelRetry.policy(options?.phases ?? 1)
    let egressFailures = 0
    return (input: Input) =>
      Effect.gen(function* () {
        const next = yield* decide(input)
        if (!next) return { retry: false as const }
        // Only the opencode gateway sends the wire alias. Other providers keep their session
        // affinity and their normal retry schedule.
        const egress =
          isEgressFailure(input.cause) &&
          input.model.providerID === Provider.ID.opencode &&
          sessionRotationEnabled()
        if (egress) egressFailures++
        const allowed =
          next.retry &&
          (!egress || (egressFailures <= SESSION_ROTATION_LIMIT && SessionEgress.canRotate(sessionID)))
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
        if (egress && SessionEgress.canRotate(sessionID)) {
          const alias = SessionEgress.rotate(sessionID)
          yield* Effect.logDebug("session egress rotated", { sessionID, alias })
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
