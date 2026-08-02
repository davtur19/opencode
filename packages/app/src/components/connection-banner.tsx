import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"

// Delay before showing the offline state so a transient stream blip (the event
// stream briefly drops between reconnect attempts) does not flash the banner.
const OFFLINE_DEBOUNCE_MS = 750

// Tracks the active server's event-stream connection reactively. Resolves the
// server SDK through the global context (no ServerSDKProvider required) so it
// can live at the app-shell level, above both the legacy and the v2 layout.
export function useServerConnectionState() {
  const global = useGlobal()
  const server = useServer()
  return createMemo(() => {
    const conn = server.current
    if (!conn) return true
    return global.ensureServerCtx(conn).sdk.event.connected()
  })
}

// When the server connection drops, shows a fixed banner ("Server offline —
// reconnecting…") and adds the `app-offline` class to <body>, which pauses all
// CSS animations (agent spinners, thinking dots, …). On reconnect the class is
// removed so animations resume; the active session is resynced by
// useConnectionResync in the session page.
export function ConnectionBanner() {
  const connected = useServerConnectionState()
  const language = useLanguage()
  const [offline, setOffline] = createSignal(false)

  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (connected()) {
      if (timer) clearTimeout(timer)
      timer = undefined
      setOffline(false)
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      setOffline(true)
    }, OFFLINE_DEBOUNCE_MS)
  })

  createEffect(() => {
    if (typeof document === "undefined") return
    document.body.classList.toggle("app-offline", offline())
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
    document.body.classList.remove("app-offline")
  })

  return (
    <Show when={offline()}>
      <div
        role="status"
        class="fixed inset-x-0 top-0 z-[9998] flex items-center justify-center gap-2 border-b border-v2-state-border-danger bg-v2-state-bg-danger px-4 py-1.5 text-12-regular text-v2-state-fg-danger"
      >
        {language.t("app.server.offline")}
      </div>
    </Show>
  )
}
