import type { ModelInfo } from "@opencode/client"
import { createMemo, createSignal, For } from "solid-js"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogIntegration } from "./dialog-integration"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"
import { modelPreferenceKey } from "../model-preference"
import { useLocation } from "../context/location"
import { useNewDesigns } from "../config"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const newDesigns = useNewDesigns()
  const data = useData()
  const dialog = useDialog()
  const location = useLocation()
  const theme = useTheme().surface("dialog")
  const [query, setQuery] = createSignal("")
  // Under new designs, favoriting does not reorder the list until the dialog is reopened.
  const favoritesAtOpen = [...local.model.favorite()]
  const favoritePriority = new Set(favoritesAtOpen.map(modelPreferenceKey))
  const isFavorite = (value: { providerID: string; modelID: string } | undefined) =>
    value !== undefined &&
    local.model.favorite().some((item) => item.providerID === value.providerID && item.modelID === value.modelID)
  // A styled span keeps its color on the highlighted row, where plain trailing text turns secondary.
  const trailing = (model: ModelInfo, favorite: boolean) => {
    if (newDesigns() && favorite) return <span style={{ fg: theme.text.formfield.selected }}>*</span>
    return free(model) ? "Free" : undefined
  }

  const connected = useConnected()
  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? (newDesigns() ? favoritesAtOpen : local.model.favorite()) : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const model = models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        const provider = providers().get(model.providerID)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: provider?.name ?? model.providerID,
            category,
            footer: trailing(model, isFavorite(item)),
            detail: newDesigns() ? () => <ModelDetail model={model} /> : undefined,
            onSelect: () => {
              onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const modelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          const value = { providerID: model.providerID, modelID: model.id }
          const favorite = isFavorite(value)
          return {
            value,
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            title: model.name,
            releaseDate: model.time.released,
            description: newDesigns() ? undefined : favorite ? "(Favorite)" : undefined,
            category: connected() ? (provider?.name ?? model.providerID) : undefined,
            footer: trailing(model, favorite),
            free: free(model),
            detail: newDesigns() ? () => <ModelDetail model={model} /> : undefined,
            onSelect() {
              onSelect(model.providerID, model.id)
            },
          }
        })
        .filter((option) => {
          if (!showSections) return true
          if (
            favorites.some(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          )
            return false
          if (
            recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
          )
            return false
          return true
        }),
      connected(),
    )

    if (needle) {
      const results = prioritizeFavorites(
        sortModelOptions(
          fuzzysort.go(needle, modelOptions, { keys: ["title", "category"] }).map((item) => item.obj),
          false,
        ),
        favoritePriority,
      )
      // Search results name the provider inline. Without a category, the trailing slot keeps the favorite marker
      // instead of falling back to the provider name.
      if (!newDesigns()) return results
      return results.map((option) => ({ ...option, description: option.providerName, category: undefined }))
    }

    return [...favoriteOptions, ...recentOptions, ...modelOptions]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: newDesigns()
            ? connected()
              ? "connect integration"
              : "view all integrations"
            : connected()
              ? "Connect an integration"
              : "View all integrations",
          selection: "none",
          onTrigger() {
            dialog.replace(() => (
              <DialogIntegration
                onConnected={(providerID) => dialog.replace(() => <DialogModel providerID={providerID} />)}
              />
            ))
          },
        },
        {
          command: "model.dialog.favorite",
          title: newDesigns() ? (option) => (isFavorite(option?.value) ? "unfavorite" : "favorite") : "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

export function prioritizeFavorites<T extends { value: { providerID: string; modelID: string } }>(
  options: T[],
  favorites: Set<string>,
) {
  return options.toSorted(
    (a, b) => Number(favorites.has(modelPreferenceKey(b.value))) - Number(favorites.has(modelPreferenceKey(a.value))),
  )
}

// The server owns model order (`Model.available()`: preferred free models first when signed out, newest first
// otherwise). This only applies the picker's grouping and keeps the server's order for everything else.
export function sortModelOptions<
  T extends {
    providerID?: string
    providerName?: string
    free?: boolean
  },
>(options: T[], grouped = true) {
  return options.toSorted((a, b) => {
    const provider = grouped
      ? Number(b.providerID === "opencode-go") - Number(a.providerID === "opencode-go") ||
        Number(b.providerID === "opencode") - Number(a.providerID === "opencode")
      : 0
    if (provider !== 0) return provider

    const name = grouped ? (a.providerName ?? "").localeCompare(b.providerName ?? "") : 0
    if (name !== 0) return name

    return Number(b.free === true) - Number(a.free === true)
  })
}

function free(model: { cost: ReadonlyArray<{ input: number }> }) {
  return model.cost.length > 0 && model.cost.every((cost) => cost.input === 0)
}

/** Price, input modalities, context window and reasoning support for the selected model. */
function ModelDetail(props: { model: ModelInfo }) {
  const theme = useTheme().surface("dialog")
  const price = () => {
    if (free(props.model)) return "Free"
    const cost = props.model.cost[0]
    if (!cost) return ""
    return `$${dollars(cost.input)}/$${dollars(cost.output)}`
  }
  const facts = () => [
    props.model.capabilities.input.map(modality).join(", "),
    tokens(props.model.limit.context),
    ...(props.model.variants.length > 0 ? ["Reasoning"] : []),
  ]
  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg={theme.text.faint} wrapMode="none">
        {price()}
      </text>
      <text fg={theme.text.faint} wrapMode="none" flexShrink={0}>
        <For each={facts().filter(Boolean)}>
          {(fact, index) => (
            <>
              {index() > 0 && <span style={{ fg: theme.hue.neutral[400] }}> · </span>}
              {fact}
            </>
          )}
        </For>
      </text>
    </box>
  )
}

function dollars(value: number) {
  return String(Number(value.toFixed(2)))
}

function modality(value: string) {
  if (value === "pdf") return "PDF"
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function tokens(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}
