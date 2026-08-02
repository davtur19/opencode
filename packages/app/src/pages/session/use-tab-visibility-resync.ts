import { makeEventListener } from "@solid-primitives/event-listener"
import type { Accessor } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"

const RESYNC_MARKER = "web-bg-resync"
const RESYNC_MIN_INTERVAL_MS = 2_000

// When the tab returns to the foreground, reconnect the event stream if it is
// down (e.g. the server restarted while the tab was hidden) and refetch the
// active session's messages/parts so nothing was missed while in the
// background. Guarded against overlapping refreshes and rapid repeated events.
export function useTabVisibilityResync(input: { sessionID: Accessor<string | undefined> }) {
  const serverSDK = useServerSDK()
  const sync = useSync()
  let lastResync = 0
  let inFlight: Promise<unknown> | undefined

  makeEventListener(document, "visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    const sessionID = input.sessionID()
    if (!sessionID) return
    const now = Date.now()
    if (now - lastResync < RESYNC_MIN_INTERVAL_MS) return
    if (inFlight) return
    lastResync = now

    const sdk = serverSDK()
    if (!sdk.event.running()) {
      console.info(`[${RESYNC_MARKER}] event stream not connected; reconnecting`)
      void sdk.event.restart()
    }
    inFlight = sync().session.sync(sessionID, { force: true }).catch(() => {})
    void inFlight.finally(() => {
      inFlight = undefined
    })
  })
}
