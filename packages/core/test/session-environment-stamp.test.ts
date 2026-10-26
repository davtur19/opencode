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

  test("rotates on every completed compaction", () => {
    const target = session("ses_a")
    const first = SessionEnvironmentStamp.id(target)
    const second = SessionEnvironmentStamp.compacted(target)

    expect(second).not.toBe(first)
    expect(SessionEnvironmentStamp.id(target)).toBe(second)
    expect(SessionEnvironmentStamp.compacted(target)).not.toBe(second)
  })

  test("rotates on an explicit reset and restarts the compaction count", () => {
    const target = session("ses_a")
    const first = SessionEnvironmentStamp.id(target)
    const reset = SessionEnvironmentStamp.reset(target)

    expect(reset).not.toBe(first)
    expect(SessionEnvironmentStamp.id(target)).toBe(reset)
    expect(SessionEnvironmentStamp.compacted(target)).not.toBe(reset)
  })

  test("clear resets the stamp", () => {
    const target = session("ses_a")
    const first = SessionEnvironmentStamp.id(target)
    SessionEnvironmentStamp.compacted(target)
    expect(SessionEnvironmentStamp.id(target)).not.toBe(first)

    SessionEnvironmentStamp.clear()
    expect(SessionEnvironmentStamp.id(target)).toBe(first)
  })
})
