import { beforeEach, describe, expect, test } from "bun:test"
import { SessionEnvironmentStamp } from "@opencode/core/session/environment-stamp"
import { SessionSchema } from "@opencode/core/session/schema"

const session = (id: string) => SessionSchema.ID.make(id)

describe("SessionEnvironmentStamp", () => {
  beforeEach(() => SessionEnvironmentStamp.clear())

  test("keeps an id stable for the same session", () => {
    expect(SessionEnvironmentStamp.id(session("ses_a"))).toBe(SessionEnvironmentStamp.id(session("ses_a")))
  })

  test("gives different sessions different ids", () => {
    expect(SessionEnvironmentStamp.id(session("ses_a"))).not.toBe(SessionEnvironmentStamp.id(session("ses_b")))
  })

  test("rotates on the configured completed compaction boundary", () => {
    const target = session("ses_a")
    const first = SessionEnvironmentStamp.id(target)
    const kept = Array.from({ length: SessionEnvironmentStamp.COMPACTIONS_PER_ROTATION - 1 }, () =>
      SessionEnvironmentStamp.compacted(target),
    )

    expect(kept.every((value) => value === first)).toBe(true)
    expect(SessionEnvironmentStamp.compacted(target)).not.toBe(first)
    expect(SessionEnvironmentStamp.id(target)).not.toBe(first)
  })

  test("clear resets the compaction count", () => {
    const target = session("ses_a")
    const first = SessionEnvironmentStamp.id(target)
    for (let index = 0; index < SessionEnvironmentStamp.COMPACTIONS_PER_ROTATION; index++)
      SessionEnvironmentStamp.compacted(target)
    expect(SessionEnvironmentStamp.id(target)).not.toBe(first)

    SessionEnvironmentStamp.clear()
    expect(SessionEnvironmentStamp.id(target)).toBe(first)
  })
})
