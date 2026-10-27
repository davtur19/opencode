import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { SessionEgress } from "@opencode/core/session/egress"
import { SessionSchema } from "@opencode/core/session/schema"

const native = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

beforeEach(() => SessionEgress.clear())
afterEach(() => setSystemTime())

describe("SessionEgress", () => {
  test("keeps one native alias per session until rotated", () => {
    const sessionID = SessionSchema.ID.make("ses_egress")
    const first = SessionEgress.identity(sessionID)
    const second = SessionEgress.identity(sessionID)

    expect(first).toBe(second)
    expect(first).not.toBe(sessionID)
    expect(first).toMatch(native)
  })

  test("rotates to a new native alias and keeps it", () => {
    const sessionID = SessionSchema.ID.make("ses_egress_rotate")
    const first = SessionEgress.identity(sessionID)
    const next = SessionEgress.rotate(sessionID)

    expect(next).not.toBe(first)
    expect(next).toMatch(native)
    expect(SessionEgress.identity(sessionID)).toBe(next)
  })

  test("refreshes an alias that reaches the gateway timestamp window", () => {
    const sessionID = SessionSchema.ID.make("ses_egress_stale")
    const first = SessionEgress.identity(sessionID)

    setSystemTime(new Date(Date.now() + SessionEgress.ALIAS_MAX_AGE_MS))
    const next = SessionEgress.identity(sessionID)

    expect(next).not.toBe(first)
    expect(next).toMatch(native)
  })

  test("keeps an alias that is still inside the gateway timestamp window", () => {
    const sessionID = SessionSchema.ID.make("ses_egress_fresh")
    const first = SessionEgress.identity(sessionID)

    setSystemTime(new Date(Date.now() + SessionEgress.ALIAS_MAX_AGE_MS - 1))

    expect(SessionEgress.identity(sessionID)).toBe(first)
  })

  test("refreshing a stale alias starts a fresh rotation budget", () => {
    const sessionID = SessionSchema.ID.make("ses_egress_stale_budget")
    for (let i = 0; i < SessionEgress.SESSION_EGRESS_BUDGET; i++) SessionEgress.rotate(sessionID)
    expect(SessionEgress.canRotate(sessionID)).toBe(false)

    setSystemTime(new Date(Date.now() + SessionEgress.ALIAS_MAX_AGE_MS))
    expect(SessionEgress.identity(sessionID)).toMatch(native)
    expect(SessionEgress.canRotate(sessionID)).toBe(true)
  })

  test("budgets rotations per session and reset starts a fresh budget", () => {
    const sessionID = SessionSchema.ID.make("ses_egress_budget")

    for (let i = 0; i < SessionEgress.SESSION_EGRESS_BUDGET; i++) {
      expect(SessionEgress.canRotate(sessionID)).toBe(true)
      SessionEgress.rotate(sessionID)
    }
    expect(SessionEgress.canRotate(sessionID)).toBe(false)

    const alias = SessionEgress.reset(sessionID)
    expect(alias).toMatch(native)
    expect(SessionEgress.canRotate(sessionID)).toBe(true)
  })

  test("keeps the map bounded", () => {
    const sessionIDs = Array.from({ length: 257 }, (_, index) => SessionSchema.ID.make(`ses_egress_${index}`))
    const first = SessionEgress.identity(sessionIDs[0])

    for (const sessionID of sessionIDs.slice(1)) SessionEgress.identity(sessionID)

    expect(SessionEgress.identity(sessionIDs[0])).not.toBe(first)
  })
})
