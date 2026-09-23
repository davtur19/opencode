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

export function getProxyForHostname(hostname: string) {
  const url = process.env[CLOUD_PROXY_ENV]
  if (!url) return undefined
  if (!isCloudHostname(hostname)) return undefined
  return url
}

export function proxiedInit(input: RequestInfo | URL, init?: RequestInit) {
  const hostname = hostnameOf(input)
  const proxy = hostname ? getProxyForHostname(hostname) : undefined
  const existingProxy =
    init !== undefined && "proxy" in init && Boolean(init.proxy)
  if (!proxy || existingProxy) return undefined
  return { ...init, proxy } satisfies ProxyAwareInit
}

// Recursively deletes keys referencing reasoning encrypted content from a
// parsed request body. Returns true when anything was removed.
function scrubEncryptedContent(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false
  let changed = false
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (scrubEncryptedContent(item)) changed = true
    }
    return changed
  }
  const record = obj as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const lowered = key.toLowerCase()
    if (lowered.includes("encrypted_content") || lowered.includes("encryptedcontent")) {
      delete record[key]
      changed = true
    } else if (scrubEncryptedContent(record[key])) {
      changed = true
    }
  }
  return changed
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
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  let changed = false
  if (Array.isArray(parsed)) {
    changed = scrubEncryptedContent(parsed)
  } else {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.include)) {
      const filtered = record.include.filter((value) => !String(value).includes("encrypted_content"))
      if (filtered.length !== record.include.length) {
        if (filtered.length > 0) record.include = filtered
        else delete record.include
        changed = true
      }
    }
    if (scrubEncryptedContent(parsed)) changed = true
  }
  return changed ? JSON.stringify(parsed) : undefined
}

// Returns a replacement init when the body must be scrubbed for a cloud
// endpoint, otherwise undefined so the caller keeps the original init.
export function scrubInit(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const body = init?.body
  if (body === undefined || body === null) return undefined
  const hostname = hostnameOf(input)
  if (!hostname || !isCloudHostname(hostname)) return undefined
  const url = urlStringOf(input)
  if (!url || (!url.includes("/responses") && !url.includes("/chat/completions"))) return undefined

  if (typeof body === "string") {
    const sanitized = sanitizeBody(body)
    return sanitized === undefined ? undefined : { ...init, body: sanitized }
  }
  // Blob, FormData, and streams are not text-decodable here; leave them alone.
  if (body instanceof ArrayBuffer) {
    const sanitized = sanitizeBody(new TextDecoder().decode(body))
    return sanitized === undefined
      ? undefined
      : { ...init, body: new TextEncoder().encode(sanitized) }
  }
  if (body instanceof Uint8Array) {
    const sanitized = sanitizeBody(new TextDecoder().decode(body))
    return sanitized === undefined
      ? undefined
      : { ...init, body: new TextEncoder().encode(sanitized) }
  }
  return undefined
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
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function hostnameOf(input: RequestInfo | URL) {
  try {
    if (typeof input === "string") return URL.canParse(input) ? new URL(input).hostname : undefined
    if (input instanceof URL) return input.hostname
    return new URL(input.url).hostname
  } catch {
    return undefined
  }
}
