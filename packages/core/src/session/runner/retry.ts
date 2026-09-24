export * as SessionRunnerRetry from "./retry.js"

import { AIError, isContextOverflowFailure } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"

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
 * intermittent401 on anonymous public requests and its free-tier402 quota blip. Callers without
 * a resolved model keep the plain reason taxonomy so auxiliary requests never mask a real
 * credential or billing failure.
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
    case "Authentication":
      return (
        model?.ref.providerID === Provider.ID.opencode &&
        model.anonymous === true &&
        error.reason.http?.status === 401
      )
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

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a session for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

// Exponential from 2s capped at 10s per gap, for 10 retries: 2, 4, 8, then 10 × 7, about 84s of
// waiting when every attempt fails (67–101s with jitter). `min` takes the faster schedule, so the
// cap applies per gap; `max` with `recurs` bounds the count.
const schedule = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("10 seconds")]),
  Schedule.recurs(10),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    const minimum = retryAfter(input)
    const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

/**
 * A transient step failure whose schedule runs out starts another fresh schedule phase instead of
 * finalizing the step: one initial policy plus renewals, each about 84s. This is the fork's
 * turn-level retry budget (TURN_RETRY_LIMIT), reworked per step because in V2 one step is one
 * logical LLM call; each renewal re-runs the failed call from scratch while the gateway heals.
 */
export const RETRY_PHASES = 4

export const policy = (sessionID: SessionSchema.ID, options?: { readonly phases?: number }) =>
  Effect.gen(function* () {
    let step = yield* Schedule.toStep(schedule)
    let attempt = 1
    let phase = 1
    return (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        let next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        // Renewal never bypasses the retry hook: an exhausted schedule returns before the hook
        // runs, while a hook veto exits below from a schedule that still has steps left.
        if (!next && input.retry && phase++ < (options?.phases ?? 1)) {
          step = yield* Schedule.toStep(schedule)
          next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        }
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        const delay = Math.ceil(Duration.toMillis(duration))
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          decision: input.retry ? { retry: true, delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        return { retry: true as const, attempt, delay: normalized }
      })
  })

/**
 * Retries one auxiliary request's transient failures under a shared `policy` allowance, letting the
 * session retry hook adjust each decision. Context overflow is never transient: callers recover it.
 */
export const transient =
  (decide: Effect.Success<ReturnType<typeof policy>>, input: Pick<Input, "agent" | "model" | "hook">) =>
  <A, R>(effect: Effect.Effect<A, AIError, R>) =>
    Effect.retry(effect, {
      while: (cause) =>
        Effect.gen(function* () {
          if (isContextOverflowFailure(cause)) return false
          const decision = yield* decide({ ...input, cause, error: toSessionError(cause), retry: isRetryable(cause) })
          if (!decision.retry) return false
          yield* Effect.sleep(decision.delay)
          return true
        }),
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
