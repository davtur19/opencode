import { expect, test } from "bun:test"
import { App } from "@opencode/core/app"

test("forces the release channel in the user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe(
    "opencode/latest/1.2.3/sdk",
  )
  expect(App.useragent(App.make({ name: "cli", version: "2.0.32", channel: "master" }))).toBe(
    "opencode/latest/2.0.32/cli",
  )
  expect(App.useragent(App.make({ name: "cli", version: "2.0.32", channel: "detached" }))).toBe(
    "opencode/latest/2.0.32/cli",
  )
  expect(App.useragent(App.make({ name: "cli", version: "2.0.32", channel: "nightly/v2" }))).toBe(
    "opencode/latest/2.0.32/cli",
  )
})

test("sanitizes user agent segments", () => {
  expect(App.useragent(App.make({ name: "cli x", version: "2.0.18/next", channel: "latest" }))).toBe(
    "opencode/latest/2.0.18-next/cli-x",
  )
})
