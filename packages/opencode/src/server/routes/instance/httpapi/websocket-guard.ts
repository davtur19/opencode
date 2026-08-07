import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// The opencode server only serves WebSocket upgrades on declared WS routes
// (currently the PTY connect route). Upgrades to any other path (for example
// the `/global/event/ws` transport some clients attempt before falling back to
// SSE) reach the catch-all UI handler and hang there without ever producing a
// response, leaving the client's socket open with zero bytes. Fail such upgrades
// fast so clients fall back to the supported transport immediately.
const WS_UPGRADE_HEADER = "upgrade"
const WS_UPGRADE_VALUE = "websocket"
const KNOWN_WS_PATHS: ReadonlyArray<RegExp> = [/^\/pty\/[^/]+\/connect$/]

export const websocketUpgradeGuard: (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, never>) => Effect.Effect<HttpServerResponse.HttpServerResponse, never> = (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const upgrade = request.headers[WS_UPGRADE_HEADER]
    if (upgrade === undefined || upgrade.toLowerCase() !== WS_UPGRADE_VALUE) return yield* effect
    const path = new URL(request.url, "http://localhost").pathname
    if (KNOWN_WS_PATHS.some((pattern) => pattern.test(path))) return yield* effect
    return HttpServerResponse.text(`WebSocket upgrades are not supported on ${path}`, { status: 400 })
  })