export * as FetchProxy from "./proxy.js"

// Hostnames that serve opencode's cloud models (the Zen/gateway inference
// endpoints). Requests to these go through the configured proxy; every other
// domain (model providers, github, telemetry, ...) is left untouched so Bun's
// env-based proxy (HTTP(S)_PROXY / NO_PROXY) still applies to them as before.
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

// Env-only cloud-model proxy config. No config-file key: the host deploys
// these as service environment variables, and env keeps the surface minimal.
const CLOUD_PROXY_ENV = "OPENCODE_CLOUD_PROXY"
const CLOUD_PROXY_DOMAINS_ENV = "OPENCODE_CLOUD_PROXY_DOMAINS"

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
  return { ...init, proxy } satisfies ProxyAwareInit
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
    return proxied ? native(input, proxied) : native(input, next)
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
