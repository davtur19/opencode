export * as SessionEgress from "./egress.js"

import { clearAliases, registerAlias } from "@opencode/util/cloud-proxy"
import { SessionSchema } from "./schema.js"

// The gateway accepts only a wire session id whose embedded timestamp is inside its freshness
// window: about 90 days in the past and 26 hours in the future. The real session id can live for
// years, so refresh the alias well before it can age out.
export const ALIAS_MAX_AGE_MS = 80 * 24 * 60 * 60 * 1000

// How many wire-identity rotations one session may spend on a gateway usage-limit block (402), an
// abuse gate (403), or a throttle (429) before the runner renews the whole identity (alias and
// environment stamp) and starts a fresh budget. Compaction and an explicit reset also start a
// fresh budget. A 5xx does not rotate: it retries on the same egress.
export const SESSION_EGRESS_BUDGET = 12

// Bound the per-session state so a long-lived server cannot grow it forever. Evicting a session
// also forgets its budget; the next request starts with a new alias, which is the same reset a
// restart performs.
const SESSION_TRACKED = 256

type Egress = {
  readonly alias: SessionSchema.ID
  readonly rotations: number
  readonly createdAt: number
}

const sessions = new Map<SessionSchema.ID, Egress>()

function remember(sessionID: SessionSchema.ID, egress: Egress) {
  sessions.delete(sessionID)
  sessions.set(sessionID, egress)
  if (sessions.size <= SESSION_TRACKED) return
  const oldest = sessions.keys().next().value
  if (oldest !== undefined) sessions.delete(oldest)
}

/**
 * The outgoing identity for a session: a native session ID that is never persisted locally and
 * never replaces the chat ID. The gateway sees this alias; the client, its events, and its UI keep
 * the real session ID. An alias that has reached the gateway's timestamp window is replaced before
 * it is sent, so a long-lived process does not keep using an identity the gateway now rejects.
 */
export function identity(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID)
  if (current && Date.now() - current.createdAt < ALIAS_MAX_AGE_MS) {
    remember(sessionID, current)
    registerAlias(current.alias, sessionID)
    return current.alias
  }
  return reset(sessionID)
}

/** Whether the session may still spend a rotation on a gateway usage-limit block. */
export function canRotate(sessionID: SessionSchema.ID) {
  return (sessions.get(sessionID)?.rotations ?? 0) < SESSION_EGRESS_BUDGET
}

/** Replaces the outgoing identity after a gateway rejection and charges one rotation. */
export function rotate(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID)
  const alias = SessionSchema.ID.create()
  remember(sessionID, { alias, rotations: (current?.rotations ?? 0) + 1, createdAt: Date.now() })
  registerAlias(alias, sessionID)
  return alias
}

/**
 * Replaces the outgoing identity after a successful compaction, an explicit reset, or when the
 * alias reaches the gateway's timestamp window, and starts a fresh budget.
 */
export function reset(sessionID: SessionSchema.ID) {
  const alias = SessionSchema.ID.create()
  remember(sessionID, { alias, rotations: 0, createdAt: Date.now() })
  registerAlias(alias, sessionID)
  return alias
}

/** Forget every process-local identity; a restart has the same effect. */
export function clear() {
  sessions.clear()
  clearAliases()
}
