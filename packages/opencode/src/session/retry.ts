import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Data, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { isRetryableMessage } from "@/provider/error"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_ATTEMPTS = 6 // 1 initial attempt + 5 retries

// Turn-level retry: when a whole assistant turn fails with a transient provider
// error (5xx / 429 / upstream JSON parse / request queue full) AFTER the
// stream-level retry (RETRY_MAX_ATTEMPTS) is exhausted, the turn is reprocessed
// from scratch up to this many total attempts before being finalized as error.
export const TURN_RETRY_LIMIT = 4

// The opencode zen gateway sometimes dies mid-generation and reports it as a
// final SSE chunk with finish_reason "network_error", or refuses the request
// outright with 503 "Upstream request failed: Endpoint is unavailable". Both
// are per-request upstream failures on their side and the next attempt usually
// lands on a healthy backend, so these get a tighter and more insistent
// schedule than generic transient errors: a fixed short interval kept up for a
// bounded window (NETWORK_STREAM_RETRY_MAX_ATTEMPTS * interval ~= 30s).
export const NETWORK_STREAM_RETRY_INTERVAL = 500
export const NETWORK_STREAM_RETRY_MAX_ATTEMPTS = 60 // 60 x 500ms ~= 30 seconds
export const NETWORK_STREAM_TURN_RETRY_LIMIT = 6

const GATEWAY_UPSTREAM_ERROR_PATTERNS = [
  /finish_reason:\s*network_error/i,
  /upstream request failed/i,
  /endpoint is unavailable/i,
]

export function isNetworkStreamError(error: unknown) {
  if (!SessionV1.APIError.isInstance(error)) return false
  return GATEWAY_UPSTREAM_ERROR_PATTERNS.some((pattern) => pattern.test(error.data.message))
}

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  // Transport-level TLS/certificate failures (e.g. Bun's "unknown certificate
  // verification error" when a MITM proxy or stale CA chain fails verification)
  // are transient like other connection failures above: the same request
  // succeeds on retry once the network path recovers.
  /unknown certificate verification error|certificate verification failed|certificate verify failed|certificate has expired|certificate is not yet valid|certificate not yet valid|self-signed certificate|certificate chain|cannot be verified|unable to verify the first certificate|handshake failure/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  // Gateway network_error streams get a fixed tight interval. The gateway never
  // sends retry hints for these (verified empirically), so server headers are
  // deliberately ignored here rather than slowing recovery.
  if (error && isNetworkStreamError(error)) return NETWORK_STREAM_RETRY_INTERVAL
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string, opts?: { retry401?: boolean }) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 401 on an anonymous opencode request is a known gateway flake
    // (invalid_bearer_credential ~1-2% even with a valid bearer), so the
    // processor only asks to retry it when no real credential is in use.
    if (status === 401 && opts?.retry401) {
      return { message: error.data.message }
    }
    // 402 from the opencode gateway is a transient free-tier quota flake
    // ("Payment Required" on free models, e.g. deepseek-v4-flash-free), not a
    // real billing failure: the same request succeeds moments later. Other
    // providers' 402s are real billing problems and stay non-retryable.
    if (status === 402 && provider === "opencode") {
      return { message: error.data.message }
    }
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }

    // Some SDKs embed the HTTP status directly in the message, e.g. "Streaming
    // response failed: [503] The request queue is full." Surface [5xx]/[429]
    // as retryable regardless of error type (mirrors provider/error.ts).
    const status = /\[(\d{3})\]/.exec(msg)?.[1]
    if (status) {
      const statusCode = Number(status)
      if (statusCode >= 500 || statusCode === 429) {
        return { message: msg }
      }
    }

    // Some gateways/SDKs omit the bracketed status but embed a known transient
    // phrase (e.g. "Service Unavailable", "upstream request timed out", "Too
    // Many Requests"). Treat those as retryable too, even without a statusCode
    // (mirrors provider/error.ts parseStreamError). 4xx non-429 messages never
    // match here.
    // Serialized JSON codes and hyphenated/underscored tokens (e.g.
    // `{"code":"resource_exhausted"}`, "service-unavailable") map to a
    // generic overloaded message; readable phrases with spaces fall through
    // to the retryable-pattern check below and keep their original text.
    if (!/\s/.test(lower) && (lower.includes("unavailable") || lower.includes("exhausted"))) {
      return { message: "Provider is overloaded" }
    }
    if (matchesRetryableMessage(msg) || isRetryableMessage(msg)) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  retry401?: boolean
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      // Cap total attempts (1 initial + N - 1 retries) instead of retrying
      // forever. Returning Cause.done stops the retry loop. Gateway
      // network_error streams get their own, more insistent cap.
      const maxAttempts = isNetworkStreamError(error) ? NETWORK_STREAM_RETRY_MAX_ATTEMPTS : RETRY_MAX_ATTEMPTS
      if (meta.attempt >= maxAttempts) return Cause.done(meta.attempt)
      const retry = retryable(error, opts.provider, { retry401: opts.retry401 })
      if (!retry) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

/**
 * Raised by the session processor when a whole turn fails with a transient
 * provider error after stream-level retries are exhausted. The run loop catches
 * it and reprocesses the turn up to TURN_RETRY_LIMIT times before finalizing
 * the assistant message as error. Permanent errors never produce this.
 */
export class TransientTurnError extends Data.TaggedError("TransientTurnError")<{
  readonly message: string
  readonly error: unknown
}> {}

// Turn-level retry policy: re-runs the failed turn (same handle, same input)
// while the failure is a TransientTurnError, capped at TURN_RETRY_LIMIT total
// attempts. `set` is invoked before each retry so the attempt can be persisted
// (e.g. as a RetryPart on the assistant message) and survive a restart.
export function turnPolicy(opts: {
  set: (input: { attempt: number; message: string; error: unknown; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      // Cap total attempts instead of retrying forever. Gateway network_error
      // streams get their own, more insistent cap.
      const failure = meta.input
      const maxAttempts =
        failure instanceof TransientTurnError && isNetworkStreamError(failure.error)
          ? NETWORK_STREAM_TURN_RETRY_LIMIT
          : TURN_RETRY_LIMIT
      if (meta.attempt >= maxAttempts) return Cause.done(meta.attempt)
      if (!(failure instanceof TransientTurnError)) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(failure.error) ? failure.error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: failure.message,
          error: failure.error,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
