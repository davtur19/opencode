import { createEffect, on, type Accessor } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"

const RESYNC_MIN_INTERVAL_MS = 2_000

// When the event stream comes back (server restarted/stopped, network blip),
// refetch the active session's messages/parts so nothing that happened while
// the server was unreachable is missed. The stream itself is already running on
// the offline -> online transition (running() === connected()), so it needs no
// manual restart here. Guarded against overlapping refreshes and rapid repeated
// events.
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

        // This effect fires on the offline -> online transition, so the event
        // stream is already running here (running() === connected()) and a
        // restart branch would never be reachable. The sync below refetches
        // anything missed while the server was unreachable.
        inFlight = sync().session.sync(sessionID, { force: true }).catch(() => {})
        void inFlight.finally(() => {
          inFlight = undefined
        })
      },
    ),
  )
}
