import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// 402 from the opencode gateway is a transient free-tier quota flake, not a
// real billing failure: the same request succeeds moments later. Retrying it
// keeps free-model turns (e.g. opencode/deepseek-v4-flash-free) alive.
function isOpenCodeErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  return status === 402 || e.isRetryable
}

// Phrases that mark a provider/gateway error as transient even when no HTTP
// status code is attached. SDKs and proxies embed these in plain error strings
// (with or without a bracketed status like "[503]"); matching them keeps the
// retry policy from surfacing a non-retryable error for 5xx/429-class failures.
// Case-insensitive substring match, so only the listed phrases ever match —
// 4xx (non-429) messages stay non-retryable.
export const RETRYABLE_MESSAGE_PHRASES = [
  "service unavailable",
  "internal server error",
  "gateway timeout",
  "bad gateway",
  "request queue is full",
  "too many requests",
  "upstream",
  "invalid json response",
  "upstream request failed",
  "upstream response was not valid json",
] as const

// 5xx / 429 statuses embedded without a `[NNN]` wrapper. Must match as standalone
// tokens (word-boundary), never as a substring of a longer number, so ordinary
// 4xx codes like 400/401/403/404 never match. e.g. "502" matches "[502]" and
// "err 502:" but not "1502" or "5021".
const RETRYABLE_STATUS_CODES = ["429", "502", "503", "504"] as const

export function isRetryableMessage(message: string) {
  const lower = message.toLowerCase()
  if (RETRYABLE_MESSAGE_PHRASES.some((phrase) => lower.includes(phrase))) return true
  return RETRYABLE_STATUS_CODES.some((code) => new RegExp(`\\b${code}\\b`).test(lower))
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") {
    // AI SDK surfaces non-2xx streaming failures as plain errors whose message
    // embeds the HTTP status, e.g. "Streaming response failed: [503] The
    // request queue is full." Treat [5xx]/[429] as transient so the retry
    // policy actually kicks in instead of surfacing a non-retryable error.
    const rawMsg = typeof input === "string" ? input : typeof raw?.message === "string" ? raw.message : undefined
    const status = rawMsg ? /\[(\d{3})\]/.exec(rawMsg)?.[1] : undefined
    if (status) {
      const statusCode = Number(status)
      return {
        type: "api_error",
        message: rawMsg ?? `Streaming response failed with status ${statusCode}`,
        statusCode,
        isRetryable: statusCode >= 500 || statusCode === 429,
        responseBody: rawMsg ?? "",
      }
    }
    // No bracketed status, but the message carries a known transient phrase
    // (e.g. "Service Unavailable", "upstream request timed out", "Too Many
    // Requests"). Treat it as a retryable api_error even without a statusCode
    // so the retry policy kicks in (mirrors session/retry.ts). 4xx non-429
    // messages never match.
    if (rawMsg && isRetryableMessage(rawMsg)) {
      return {
        type: "api_error",
        message: rawMsg,
        isRetryable: true,
        responseBody: rawMsg,
      }
    }
    return
  }

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai")
      ? isOpenAiErrorRetryable(input.error)
      : input.providerID === "opencode"
        ? isOpenCodeErrorRetryable(input.error)
        : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
