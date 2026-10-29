// Cloud proxy configuration shared by the fetch wrapper and the session runner. It lives apart
// from the wrapper because the wrapper needs DOM types to describe fetch, and the runner needs
// only this contract to decide whether a gateway rejection can be retried.
export const CLOUD_PROXY_ENV = "OPENCODE_CLOUD_PROXY"
export const CLOUD_PROXY_DOMAINS_ENV = "OPENCODE_CLOUD_PROXY_DOMAINS"
// Session-addressed cloud proxy. When enabled, each cloud request carries its session, its
// attempt number, and the previous failure in the proxy URL userinfo, which Bun forwards as
// Proxy-Authorization. A CONNECT tunnel hides every header and the body from the proxy, so that
// userinfo is the only channel that addresses a session without terminating TLS, and it is also
// where the proxy learns why the previous attempt failed: the status, cf-ray, and the gateway log
// id all live inside the tunnel. The proxy owns egress selection, blocking, and budgets; this side
// only advances the attempt so the retried request opens a new tunnel instead of reusing the one
// bound to the rejected egress. Without the flag the proxy URL stays untouched.
export const CLOUD_PROXY_AUTH_ENV = "OPENCODE_CLOUD_PROXY_AUTH"

// Egresses one session may consume in one step before the client stops rotating. Each gateway
// usage-limit block (402), abuse gate (403), throttle (429), or 502 gateway refusal rotates the
// session's outgoing wire alias, so every retry leaves under a new identity and address; the pool
// is shared, so a stuck step must not walk it. The proxy enforces its own budget as well. Other
// 5xx do not rotate: the upstream, not the address, is usually the failing part, so they retry on
// the same egress. The limit is configurable because it depends on how many egresses a deployment
// provides.
export const CLOUD_PROXY_ROTATION_LIMIT_ENV = "OPENCODE_CLOUD_PROXY_ROTATION_LIMIT"
const DEFAULT_SESSION_ROTATION_LIMIT = 3

const rotationLimit = () => {
  const value = process.env[CLOUD_PROXY_ROTATION_LIMIT_ENV]
  if (value === undefined) return DEFAULT_SESSION_ROTATION_LIMIT
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_ROTATION_LIMIT
}

export const SESSION_ROTATION_LIMIT = rotationLimit()

export function sessionRotationEnabled() {
  const value = process.env[CLOUD_PROXY_AUTH_ENV]
  if (value === undefined) return false
  if (!["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return false
  return Boolean(process.env[CLOUD_PROXY_ENV])
}

// The gateway sees a rotating wire alias, not the real session ID. The proxy
// needs the opposite: a key that survives an alias rotation, so attempt N+1
// can leave from a different egress. SessionEgress registers the pair when it
// creates or rotates an alias; the fetch wrapper reads it back without putting
// the real ID on the wire.
const aliasOwners = new Map<string, string>()
const ALIAS_OWNERS_TRACKED = 1024

export function registerAlias(alias: string, owner: string) {
  aliasOwners.delete(alias)
  aliasOwners.set(alias, owner)
  if (aliasOwners.size <= ALIAS_OWNERS_TRACKED) return
  const oldest = aliasOwners.keys().next().value
  if (oldest !== undefined) aliasOwners.delete(oldest)
}

export function keyForAlias(alias: string) {
  return aliasOwners.get(alias)
}

export function clearAliases() {
  aliasOwners.clear()
}
