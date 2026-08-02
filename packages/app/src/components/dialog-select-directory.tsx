import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import type { ListRef } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { loadHomeSessionIndex } from "@/context/global-sync/home-session-index"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { cleanPickerInput, createDirectorySearch, displayPickerPath } from "./directory-picker-domain"
import { pathKey } from "@/utils/path-key"
import type { Path } from "@opencode-ai/sdk/v2/client"

interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
  server: ServerConnection.Any
}

type Row = {
  absolute: string
  search: string
  group: "recent" | "known" | "folders"
}

function toRow(absolute: string, home: string, group: Row["group"]): Row {
  const full = displayPickerPath(absolute, "", "")
  const tilde = displayPickerPath(full, "~", home)
  const withSlash = (value: string) => {
    if (!value) return ""
    if (value.endsWith("/")) return value
    return value + "/"
  }

  const search = Array.from(
    new Set([full, withSlash(full), tilde, withSlash(tilde), getFilename(full)].filter(Boolean)),
  ).join("\n")
  return { absolute: full, search, group }
}

function uniqueRows(rows: Row[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.absolute)) return false
    seen.add(row.absolute)
    return true
  })
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const global = useGlobal()
  const { sync, sdk, ...serverCtx } = global.ensureServerCtx(props.server)
  const dialog = useDialog()
  const language = useLanguage()

  const [filter, setFilter] = createSignal("")
  let list: ListRef | undefined

  const missingHome = createMemo(() => !sync.data.path.home)
  const [fallbackPath] = createResource(
    () => (missingHome() ? true : undefined),
    async (): Promise<Path | undefined> => {
      if ((await sdk.protocol) !== "v1") return
      return sdk.client.path
        .get()
        .then((result) => result.data)
        .catch(() => undefined)
    },
    { initialValue: undefined },
  )

  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")
  const start = createMemo(
    () => sync.data.path.home || sync.data.path.directory || fallbackPath()?.home || fallbackPath()?.directory,
  )

  const directories = createDirectorySearch({
    sdk,
    home,
    base: start,
  })

  // Directories that carry root sessions for this server, derived from the same
  // home session index the home sessions list uses (shared query cache).
  const knownDirectories = useQuery(() => ({
    queryKey: sync.homeSessions.indexKey,
    queryFn: async ({ signal }) => {
      const cache = sync.homeSessions
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
  }))
  const knownSessionDirs = createMemo(() => {
    const sessions = sync.homeSessions.sessions(knownDirectories.data, undefined)
    return Array.from(new Set(sessions.map((session) => pathKey(session.directory))))
  })

  // Suggestions shown when the query is empty or the search found nothing:
  // every known session directory plus shortcuts for home and the CWD.
  const suggestions = createMemo(() => {
    const rows: Row[] = knownSessionDirs().map((directory) => toRow(directory, home(), "known"))
    const homeDirectory = home()
    const cwd = sync.data.path.directory
    if (homeDirectory) rows.push(toRow(homeDirectory, homeDirectory, "known"))
    if (cwd && pathKey(cwd) !== pathKey(homeDirectory || cwd)) rows.push(toRow(cwd, homeDirectory, "known"))
    return rows
  })

  const recentProjects = createMemo(() => {
    const projects = serverCtx.projects.list()
    const byProject = new Map<string, number>()

    for (const project of projects) {
      let at = 0
      const dirs = [project.worktree, ...(project.sandboxes ?? [])]
      for (const directory of dirs) {
        const sessions = sync.child(directory, { bootstrap: false })[0].session
        for (const session of sessions) {
          if (session.time.archived) continue
          const updated = session.time.updated ?? session.time.created
          if (updated > at) at = updated
        }
      }
      byProject.set(project.worktree, at)
    }

    return projects
      .map((project, index) => ({ project, at: byProject.get(project.worktree) ?? 0, index }))
      .sort((a, b) => b.at - a.at || a.index - b.index)
      .slice(0, 5)
      .map(({ project }) => {
        const row = toRow(project.worktree, home(), "recent")
        const name = project.name || getFilename(project.worktree)
        return {
          ...row,
          search: `${row.search}\n${name}`,
        }
      })
  })

  const items = async (value: string) => {
    const results = await directories(value)
    const directoryRows = results.map((absolute) => toRow(absolute, home(), "folders"))
    const suggestionRows = !value.trim() || results.length === 0 ? suggestions() : []
    return uniqueRows([...recentProjects(), ...suggestionRows, ...directoryRows])
  }

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  return (
    <Dialog title={props.title ?? language.t("command.project.open")}>
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.directory.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.directory.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => x.absolute}
        filterKeys={["search"]}
        groupBy={(item) => item.group}
        sortGroupsBy={(a, b) => {
          const order: Record<string, number> = { recent: 0, known: 1, folders: 2 }
          return (order[a.category] ?? 0) - (order[b.category] ?? 0)
        }}
        groupHeader={(group) =>
          group.category === "recent"
            ? language.t("home.recentProjects")
            : group.category === "known"
              ? language.t("dialog.directory.knownDirectories")
              : language.t("command.project.open")
        }
        ref={(r) => (list = r)}
        onFilter={(value) => setFilter(cleanPickerInput(value))}
        onKeyEvent={(e, item) => {
          if (e.key !== "Tab") return
          if (e.shiftKey) return
          if (!item) return

          e.preventDefault()
          e.stopPropagation()

          const value = displayPickerPath(item.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
        }}
        onSelect={(path) => {
          if (!path) return
          resolve(path.absolute)
        }}
      >
        {(item) => {
          const path = displayPickerPath(item.absolute, filter(), home())
          if (path === "~") {
            return (
              <div data-directory-path={item.absolute} class="w-full flex items-center justify-between rounded-md">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular min-w-0">
                    <span class="text-text-strong whitespace-nowrap">~</span>
                    <span class="text-text-weak whitespace-nowrap">/</span>
                  </div>
                </div>
              </div>
            )
          }
          return (
            <div data-directory-path={item.absolute} class="w-full flex items-center justify-between rounded-md">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {getDirectory(path)}
                  </span>
                  <span class="text-text-strong whitespace-nowrap">{getFilename(path)}</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
