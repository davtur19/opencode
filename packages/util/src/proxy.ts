export * as FetchProxy from "./proxy.js"

import { CLOUD_PROXY_DOMAINS_ENV, CLOUD_PROXY_ENV, sessionRotationEnabled, SESSION_ROTATION_LIMIT } from "./cloud-proxy.js"

export { SESSION_ROTATION_LIMIT, sessionRotationEnabled }

// Hostnames that serve opencode's cloud models (the Zen/gateway inference
// endpoints). Requests to these go through the configured proxy; every other
// domain (model providers, github, telemetry, ...) is left untouched so Bun's
// env-based proxy (HTTP(S)_PROXY / NO_PROXY) still applies to them as before.
// The gateway also gates on the TLS client stack: only the CLI's Bun/BoringSSL
// fetch passes. Replaying the same request through curl, Python, or a
// Node/OpenSSL client returns the same free-limit 429 even with valid ids,
// headers, body, and a fresh egress. Keep cloud traffic on the runtime fetch.
const OPENCODE_DOMAINS = [
  "opencode.ai",
  "www.opencode.ai",
  "models.opencode.ai",
  "zenmux.ai",
  "gateway.opencode.ai",
  "api.opencode.ai",
  "app.opencode.ai",
  "console.opencode.ai",
  "dev.opencode.ai",
]

// Bun accepts `proxy` in the fetch init even though the DOM types omit it.
type ProxyAwareInit = RequestInit & { proxy?: string }

// Parsed JSON from an LLM request body (strings, numbers, booleans, null,
// arrays, and string-keyed objects). Used instead of `unknown` so the scrub
// walks a concrete contract after JSON.parse.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function parseDomains(value: string | undefined) {
  if (!value) return undefined
  const domains = value
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean)
  return domains.length ? domains : undefined
}

function cloudDomains(): string[] {
  return parseDomains(process.env[CLOUD_PROXY_DOMAINS_ENV]) ?? OPENCODE_DOMAINS
}

function matchesHostname(hostname: string, domain: string) {
  if (domain.startsWith("*.")) return hostname.endsWith(domain.slice(1))
  return hostname === domain
}

function isCloudHostname(hostname: string) {
  return cloudDomains().some((domain) => matchesHostname(hostname, domain))
}

function isEncryptedContentKey(key: string) {
  const lowered = key.toLowerCase()
  return lowered.includes("encrypted_content") || lowered.includes("encryptedcontent")
}

function decodeUtf8(bytes: ArrayBufferView | ArrayBuffer) {
  const view =
    bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return new TextDecoder().decode(view)
}

// Narrows BodyInit to text without a runtime typeof: every non-string member
// is an object constructor check; the remainder is string.
function bodyToText(body: BodyInit): string | undefined {
  if (body instanceof ArrayBuffer) return decodeUtf8(body)
  if (ArrayBuffer.isView(body)) return decodeUtf8(body)
  if (body instanceof URLSearchParams) return body.toString()
  // Blob, FormData, and ReadableStream are not cheaply sync-decodable here.
  if (body instanceof Blob) return undefined
  if (body instanceof FormData) return undefined
  if (body instanceof ReadableStream) return undefined
  return body
}

// The dedicated proxy key is the egress epoch: it survives the wire alias a gateway retry
// rotates, so the retry can report the relay the failed attempt used. The session id remains the
// fallback for requests that predate the header, and the affinity for the few cloud requests that
// carry no session id at all.
const SESSION_HEADERS = [
  "x-opencode-proxy-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
]

// Bound the per-session state so a long-lived server cannot grow it forever.
const SESSION_TRACKED = 256

type Rotation = {
  readonly boot: string
  readonly attempt: number
  readonly status?: number
  readonly cfRay?: string
  readonly logID?: string
}

const rotations = new Map<string, Rotation>()

// Tells this process apart from the previous one. The attempt counter starts over on restart, and
// the proxy must not attribute a fresh retry to an egress it served from the old process.
const boot = crypto.randomUUID().replaceAll("-", "").slice(0, 12)

function headerValue(headers: HeadersInit | undefined, name: string) {
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === name)
    return entry?.[1]
  }
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
  return undefined
}

// The AI layer passes the request headers either on the init or on a Request, so
// both shapes are consulted; an explicit init always wins.
function sessionKey(input: RequestInfo | URL, init?: RequestInit) {
  for (const name of SESSION_HEADERS) {
    const fromInit = headerValue(init?.headers, name)
    if (fromInit) return fromInit
    if (input instanceof Request) {
      const fromRequest = input.headers.get(name)
      if (fromRequest) return fromRequest
    }
  }
  return undefined
}

function remember(key: string, rotation: Rotation) {
  rotations.delete(key)
  rotations.set(key, rotation)
  if (rotations.size <= SESSION_TRACKED) return
  const oldest = rotations.keys().next().value
  if (oldest !== undefined) rotations.delete(oldest)
}

// base64url keeps the token inside the userinfo alphabet, so the proxy URL needs no escaping and
// the proxy decodes the whole payload at once. Every field is ASCII.
function encodeToken(rotation: Rotation) {
  return btoa(JSON.stringify(rotation)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

// A 402 is the gateway's usage-limit block, a 403 the abuse gate, and a 429 the throttle or free
// usage cap; each means the next attempt should leave from another address. A 5xx stays on the
// same egress: the upstream, not the address, is usually the failing part, so the runner retries
// it without advancing the proxy attempt.
const EGRESS_STATUSES = new Set([402, 403, 429])

/**
 * Records the failure the gateway returned inside the tunnel, so the retried request can carry it
 * to the proxy. Only the wrapper sees the status and the headers, and only the retry that follows
 * benefits from them. The attempt always advances: the proxy blocks the relay recorded for the
 * previous attempt, so reusing a capped attempt would block the wrong relay and let the retry land
 * on the one that just failed. The epoch key bounds the state instead.
 */
export function noteResponseStatus(
  key: string | undefined,
  response: { readonly status: number; readonly headers: Headers },
) {
  if (key === undefined) return
  if (!sessionRotationEnabled()) return
  if (!EGRESS_STATUSES.has(response.status)) return
  const state = rotations.get(key) ?? { boot, attempt: 0 }
  remember(key, {
    boot: state.boot,
    attempt: state.attempt + 1,
    status: response.status,
    cfRay: response.headers.get("cf-ray") ?? undefined,
    logID: response.headers.get("x-opencode-log-id") ?? undefined,
  })
}

function sessionProxy(proxy: string, key: string) {
  const state = rotations.get(key) ?? { boot, attempt: 0 }
  // The failure describes the attempt that just failed and only the next request needs it, so it
  // is consumed here: a later, unrelated request must not report the same failure a second time.
  remember(key, { boot: state.boot, attempt: state.attempt })
  const url = new URL(proxy)
  return `${url.protocol}//${key}:${encodeToken(state)}@${url.host}`
}

export function getProxyForHostname(hostname: string) {
  const url = process.env[CLOUD_PROXY_ENV]
  if (!url) return undefined
  if (!isCloudHostname(hostname)) return undefined
  return url
}

export function proxiedInit(input: RequestInfo | URL, init?: RequestInit) {
  const hostname = hostnameOf(input)
  const proxy = hostname ? getProxyForHostname(hostname) : undefined
  const existingProxy = init !== undefined && "proxy" in init && Boolean(init.proxy)
  if (!proxy || existingProxy) return undefined
  const key = sessionRotationEnabled() ? sessionKey(input, init) : undefined
  return { ...init, proxy: key === undefined ? proxy : sessionProxy(proxy, key) } satisfies ProxyAwareInit
}

// Last-chance defense at the fetch boundary: removes `include` entries and
// deep keys referencing reasoning encrypted content from cloud request
// bodies. The AI SDK re-injects them after session middleware strips them,
// and the cloud gateway rejects the request when they are present. Only
// cloud hostnames are scrubbed so OpenAI/copilot `include` replay keeps
// working on non-cloud providers.
export function sanitizeBody(body: string): string | undefined {
  const lowered = body.toLowerCase()
  if (!lowered.includes("encrypted_content") && !lowered.includes("encryptedcontent")) return undefined

  let changed = false
  let scrubbed: JsonValue
  try {
    // JSON.parse returns the parsed tree; the reviver only rewrites
    // encrypted_content keys and include entries, preserving JsonValue.
    scrubbed = JSON.parse(body, (key: string, value: JsonValue) => {
      if (key.length > 0 && isEncryptedContentKey(key)) {
        changed = true
        return undefined
      }
      if (key === "include" && Array.isArray(value)) {
        const filtered = value.filter((item) => !String(item).includes("encrypted_content"))
        if (filtered.length !== value.length) {
          changed = true
          return filtered.length > 0 ? filtered : undefined
        }
      }
      return value
    })
  } catch {
    return undefined
  }
  if (!changed) return undefined
  return JSON.stringify(scrubbed)
}

// Returns a replacement init when the body must be scrubbed for a cloud
// endpoint, otherwise undefined so the caller keeps the original init.
export function scrubInit(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const body = init?.body
  if (body === undefined || body === null) return undefined
  const hostname = hostnameOf(input)
  if (!hostname || !isCloudHostname(hostname)) return undefined
  const url = urlStringOf(input)
  if (!url.includes("/responses") && !url.includes("/chat/completions")) return undefined

  const text = bodyToText(body)
  if (text === undefined) return undefined
  const sanitized = sanitizeBody(text)
  if (sanitized === undefined) return undefined
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { ...init, body: new TextEncoder().encode(sanitized) }
  }
  return { ...init, body: sanitized }
}

let installed = false

export function install() {
  if (installed) return
  installed = true
  const native = globalThis.fetch.bind(globalThis)
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    const scrubbed = scrubInit(input, init)
    const next = scrubbed ?? init
    const proxied = proxiedInit(input, next)
    const response = proxied ? native(input, proxied) : native(input, next)
    if (proxied === undefined) return response
    // The retry that follows this failure rebuilds the proxy URL from the recorded state, so the
    // observation must land before the caller reacts to the response, not after.
    const key = sessionKey(input, next)
    return response.then((result) => {
      noteResponseStatus(key, result)
      return result
    })
  }
  // SAFETY: Bun's fetch has multiple overloads; the wrapper preserves the (input, init) call shape used by every caller.
  globalThis.fetch = wrapped as typeof globalThis.fetch
}

function urlStringOf(input: RequestInfo | URL) {
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return input
}

function hostnameOf(input: RequestInfo | URL) {
  try {
    if (input instanceof URL) return input.hostname
    if (input instanceof Request) return new URL(input.url).hostname
    return URL.canParse(input) ? new URL(input).hostname : undefined
  } catch {
    return undefined
  }
}
