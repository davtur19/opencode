export * as App from "./app.js"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export const Metadata = Context.Reference<Info>("@opencode/App", {
  defaultValue: () => make(),
})

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

export function useragent(app: Info) {
  const segment = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-")
  // Local and source builds stamp the checkout branch (for example `master` or
  // `detached`) as the channel, but downstream only accepts release channels.
  // Always present the release channel so the Console treats every build as a
  // released client instead of gating it out.
  return `opencode/latest/${segment(app.version)}/${segment(app.name)}`
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Metadata, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Metadata, layer: layer(input), deps: [] })

export const node = configured()
