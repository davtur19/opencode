import { expect, test } from "bun:test"
import { App } from "@opencode/core/app"

test("formats app metadata as a user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe("opencode/beta/1.2.3/sdk")
})

test("sanitizes user agent segments", () => {
  expect(App.useragent(App.make({ name: "cli", version: "2.0.18", channel: "nightly/v2" }))).toBe(
    "opencode/nightly-v2/2.0.18/cli",
  )
})
