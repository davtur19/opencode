import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})

test("Agent.Info omits an unset subagentsBackground and preserves a set one", () => {
  const encode = Schema.encodeSync(Agent.Info)
  const base = Agent.Info.default(Agent.ID.make("build"))

  expect(encode(base)).not.toHaveProperty("subagentsBackground")
  expect(encode({ ...base, subagentsBackground: undefined })).not.toHaveProperty("subagentsBackground")
  expect(encode({ ...base, subagentsBackground: false })).toHaveProperty("subagentsBackground", false)
})
