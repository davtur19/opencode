export * as SessionEgress from "./egress.js"

import { SessionSchema } from "./schema.js"

// How many wire-identity rotations one session may spend on gateway 403/429 or 502/503/504 before
// the runner stops rotating. Compaction and an explicit reset start a fresh budget. Once it is
// spent, a 403/429 surfaces the failure, while a 5xx keeps retrying on the last egress because the
// upstream, not the address, is usually the failing part.
export const SESSION_EGRESS_BUDGET = 12

// Bound the per-session state so a long-lived server cannot grow it forever. Evicting a session
// also forgets its budget; the next request starts with a new alias, which is the same reset a
// restart performs.
const SESSION_TRACKED = 256

type Egress = {
  readonly alias: SessionSchema.ID
  readonly rotations: number
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
 * the real session ID.
 */
export function identity(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID)
  if (current) {
    remember(sessionID, current)
    return current.alias
  }
  const alias = SessionSchema.ID.create()
  remember(sessionID, { alias, rotations: 0 })
  return alias
}

/** Whether the session may still spend a rotation on a gateway rejection. */
export function canRotate(sessionID: SessionSchema.ID) {
  return (sessions.get(sessionID)?.rotations ?? 0) < SESSION_EGRESS_BUDGET
}

/** Replaces the outgoing identity after a gateway rejection and charges one rotation. */
export function rotate(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID)
  const alias = SessionSchema.ID.create()
  remember(sessionID, { alias, rotations: (current?.rotations ?? 0) + 1 })
  return alias
}

/** Replaces the outgoing identity after a successful compaction and starts a fresh budget. */
export function reset(sessionID: SessionSchema.ID) {
  const alias = SessionSchema.ID.create()
  remember(sessionID, { alias, rotations: 0 })
  return alias
}

/** Forget every process-local identity; a restart has the same effect. */
export function clear() {
  sessions.clear()
}
