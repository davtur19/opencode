export * as FetchProxy from "./proxy"

// Hostnames that serve opencode's cloud models (the Zen/gateway inference
// endpoints). Requests to these go through the configured proxy; every other
// domain (model providers, the opencode console, github, telemetry, ...) is
// left untouched so Bun's env-based proxy (HTTP(S)_PROXY / NO_PROXY) still
// applies to them as before.
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

// Env vars for the cloud-model proxy, independent of the config file. They take
// precedence over `proxy` in opencode.json.
const CLOUD_PROXY_ENV = "OPENCODE_CLOUD_PROXY"
const CLOUD_PROXY_DOMAINS_ENV = "OPENCODE_CLOUD_PROXY_DOMAINS"

export interface Config {
  url: string
  domains?: string[]
}

let config: Config | undefined

export function setConfig(next: Config | undefined) {
  config = next
}

function effectiveConfig() {
  const envUrl = process.env[CLOUD_PROXY_ENV]
  const envDomains = parseDomains(process.env[CLOUD_PROXY_DOMAINS_ENV])
  if (envUrl) return { url: envUrl, domains: envDomains }
  if (!config) return undefined
  return envDomains ? { ...config, domains: envDomains } : config
}

function parseDomains(value: string | undefined) {
  if (!value) return undefined
  const domains = value.split(",").map((domain) => domain.trim()).filter(Boolean)
  return domains.length ? domains : undefined
}

export function getProxyForHostname(hostname: string) {
  const current = effectiveConfig()
  if (!current) return undefined
  const domains = current.domains?.length ? current.domains : OPENCODE_DOMAINS
  for (const domain of domains) {
    if (matchesHostname(hostname, domain)) return current.url
  }
  return undefined
}

function matchesHostname(hostname: string, domain: string) {
  if (domain.startsWith("*.")) return hostname.endsWith(domain.slice(1))
  return hostname === domain
}

const nativeFetch = globalThis.fetch.bind(globalThis)
let installed = false

// Bun accepts `proxy` in the fetch init even though the bundled DOM types omit it.
type ProxyAwareInit = RequestInit & { proxy?: string }

export function proxiedInit(input: RequestInfo | URL, init?: RequestInit) {
  const hostname = hostnameOf(input)
  const proxy = hostname ? getProxyForHostname(hostname) : undefined
  const existingProxy = (init as ProxyAwareInit | undefined)?.proxy
  if (!proxy || existingProxy) return undefined
  return { ...init, proxy } as ProxyAwareInit
}

export function install() {
  if (installed) return
  installed = true
  const native = nativeFetch
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun's fetch type has multiple overloads; the wrapper matches its call surface.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let proxied = proxiedInit(input, init)
    // Nuclear fix: at the fetch boundary, scrub ALL `encrypted_content`
    // references from request bodies destined for cloud endpoints.
    // The SDK re-adds these after our middleware strips them.
    if (init?.body) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/responses") || url.includes("/chat/completions")) {
        const bodyStr = typeof init.body === "string" ? init.body : ""
        if (bodyStr.includes("encrypted_content")) {
          try {
            const parsed = JSON.parse(bodyStr)
            let changed = false
            // 1) Remove top-level include field if it contains encrypted_content
            if (Array.isArray(parsed.include)) {
              const filtered = parsed.include.filter((v: unknown) => !String(v).includes("encrypted_content"))
              if (filtered.length !== parsed.include.length) {
                console.error("[proxy-fetch] NUCLEAR: removing include field:", JSON.stringify(parsed.include))
                if (filtered.length > 0) parsed.include = filtered
                else delete parsed.include
                changed = true
              }
            }
            // 2) Deep-scrub any key containing "encrypted_content" or "encryptedContent"
            function scrub(obj: unknown): boolean {
              if (!obj || typeof obj !== "object") return false
              let didChange = false
              if (Array.isArray(obj)) {
                for (let i = obj.length - 1; i >= 0; i--) {
                  if (scrub(obj[i])) didChange = true
                }
              } else {
                for (const key of Object.keys(obj as Record<string, unknown>)) {
                  if (key.toLowerCase().includes("encrypted_content") || key.toLowerCase().includes("encryptedcontent")) {
                    console.error("[proxy-fetch] NUCLEAR: deleting key", key)
                    delete (obj as Record<string, unknown>)[key]
                    didChange = true
                  } else if (scrub((obj as Record<string, unknown>)[key])) {
                    didChange = true
                  }
                }
              }
              return didChange
            }
            if (scrub(parsed)) changed = true
            if (changed) {
              init = { ...init, body: JSON.stringify(parsed) }
              proxied = proxiedInit(input, init)
            }
          } catch {
            // unparseable — leave as-is
          }
        }
      }
    }
    return proxied ? native(input, proxied) : native(input, init)
  }) as typeof globalThis.fetch
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