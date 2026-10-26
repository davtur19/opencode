import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const ResetResponse = Schema.Struct({ data: Schema.Struct({ environmentID: Schema.String }) })

const makeRequest = Effect.fn(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (path: string, method: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      expect(response.status).toBe(200)
      return response.json()
    })
})

it.live("resets the provider identity without changing the session", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", "POST", {}))

    const first = Schema.decodeUnknownSync(ResetResponse)(
      yield* request(`/api/session/${created.data.id}/identity/reset`, "POST"),
    )
    const second = Schema.decodeUnknownSync(ResetResponse)(
      yield* request(`/api/session/${created.data.id}/identity/reset`, "POST"),
    )

    expect(second.data.environmentID).not.toBe(first.data.environmentID)
    const fetched = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${created.data.id}`, "GET"))
    expect(fetched.data.id).toBe(created.data.id)
  }).pipe(Effect.scoped),
)
