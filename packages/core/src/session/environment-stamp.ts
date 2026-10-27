export * as SessionEnvironmentStamp from "./environment-stamp.js"

import { createHash } from "crypto"
import { SessionSchema } from "./schema.js"

/** Rotate the environment stamp after every completed compaction. */
export const COMPACTIONS_PER_ROTATION = 1

const SESSION_TRACKED = 256
// A new process starts under a new stamp, so a restart never falls back to an old bucket.
const boot = crypto.randomUUID().replaceAll("-", "").slice(0, 8)

type State = {
  readonly generation: number
  readonly compactions: number
}

const sessions = new Map<SessionSchema.ID, State>()

function remember(sessionID: SessionSchema.ID, state: State) {
  sessions.delete(sessionID)
  sessions.set(sessionID, state)
  if (sessions.size <= SESSION_TRACKED) return
  const oldest = sessions.keys().next().value
  if (oldest !== undefined) sessions.delete(oldest)
}

const stamp = (sessionID: SessionSchema.ID, generation: number) =>
  createHash("sha256").update(`${boot}:${sessionID}:${generation}`).digest("hex").slice(0, 12)

/** The opaque environment id the gateway sees inside the prompt's env block. */
export function id(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID)
  if (current) {
    remember(sessionID, current)
    return stamp(sessionID, current.generation)
  }
  const state = { generation: 0, compactions: 0 }
  remember(sessionID, state)
  return stamp(sessionID, 0)
}

/** Advances the compaction count and rotates the stamp after every completed compaction. */
export function compacted(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID) ?? { generation: 0, compactions: 0 }
  const compactions = current.compactions + 1
  const generation = compactions % COMPACTIONS_PER_ROTATION === 0 ? current.generation + 1 : current.generation
  remember(sessionID, { generation, compactions })
  return stamp(sessionID, generation)
}

/** Rotates the stamp on an identity reset, manual or automatic, and restarts the compaction count. */
export function reset(sessionID: SessionSchema.ID) {
  const current = sessions.get(sessionID) ?? { generation: 0, compactions: 0 }
  const generation = current.generation + 1
  remember(sessionID, { generation, compactions: 0 })
  return stamp(sessionID, generation)
}

/** Forget every process-local stamp; a restart also changes the boot prefix. */
export function clear() {
  sessions.clear()
}
