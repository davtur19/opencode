import { createEffect, on, type Accessor } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"

const RESYNC_MARKER = "web-conn-resync"
const RESYNC_MIN_INTERVAL_MS = 2_000

// When the event stream goes down and comes back (server restarted/stopped,
// network blip), reconnect it if it is not already running and refetch the
// active session's messages/parts so nothing that happened while the server
// was unreachable is missed. Fires on the offline -> online transition only,
// and is guarded against overlapping refreshes and rapid repeated events.
export function useConnectionResync(input: { sessionID: Accessor<string | undefined> }) {
  const serverSDK = useServerSDK()
  const sync = useSync()
  let lastResync = 0
  let inFlight: Promise<unknown> | undefined

  createEffect(
    on(
      () => serverSDK().event.connected(),
      (connected, previous) => {
        if (previous !== false) return
        if (!connected) return
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
        inFlight = sync().session.sync(sessionID, { force: true })
        void inFlight.finally(() => {
          inFlight = undefined
        })
      },
    ),
  )
}
