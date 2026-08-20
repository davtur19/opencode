import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import type { ProviderMetadata, Usage } from "@opencode-ai/llm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV2 } from "@opencode-ai/core/session"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { locationServiceMapLayer } from "@opencode-ai/core/location-services"

import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { Global } from "@opencode-ai/core/global"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Context, Schema, Types } from "effect"
import { NonNegativeInt, optional } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionMessage } from "@opencode-ai/schema/session-message"

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert
    ? {
        messageID: MessageID.make(row.revert.messageID),
        partID: row.revert.partID ? PartID.make(row.revert.partID) : undefined,
        snapshot: row.revert.snapshot,
        diff: row.revert.diff,
      }
    : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    metadata: row.metadata ?? undefined,
    revert,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert
      ? {
          messageID: SessionMessage.ID.make(info.revert.messageID),
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
        }
      : null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(Snapshot.FileDiff)),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optional(NonNegativeInt),
  archived: optional(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optional(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optional(WorkspaceV2.ID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  summary: optional(Summary),
  cost: optional(Schema.Finite),
  tokens: optional(Tokens),
  share: optional(Share),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(Model),
  version: Schema.String,
  metadata: optional(Metadata),
  time: Time,
  permission: optional(PermissionV1.Ruleset),
  revert: optional(Revert),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectV2.ID,
  name: optional(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    workspaceID: Schema.optional(WorkspaceV2.ID),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

export type GlobalListInput = {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}

export const Event = {
  Created: SessionV1.Event.Created,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: SessionV1.Event.Diff,
  Error: SessionV1.Event.Error,
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0)
  const safe = (value: number) => Math.max(0, finite(value))
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  return {
    cost:
      typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0
        ? new Decimal(totalNanoAiu).div(100_000_000_000).toNumber()
        : safe(
            new Decimal(0)
              .add(new Decimal(tokens.input).mul(finite(costInfo?.input ?? 0)).div(1_000_000))
              .add(new Decimal(tokens.output).mul(finite(costInfo?.output ?? 0)).div(1_000_000))
              .add(new Decimal(tokens.cache.read).mul(finite(costInfo?.cache?.read ?? 0)).div(1_000_000))
              .add(new Decimal(tokens.cache.write).mul(finite(costInfo?.cache?.write ?? 0)).div(1_000_000))
              // TODO: update models.dev to have better pricing model, for now:
              // charge reasoning tokens at the same rate as output tokens
              .add(new Decimal(tokens.reasoning).mul(finite(costInfo?.output ?? 0)).div(1_000_000))
              .toNumber(),
          ),
    tokens,
  }
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly listGlobal: (input?: GlobalListInput) => Effect.Effect<GlobalInfo[]>
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    metadata?: typeof Metadata.Type
    permission?: PermissionV1.Ruleset
    workspaceID?: WorkspaceV2.ID
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type) => Effect.Effect<void>
  readonly setAgentModel: (input: {
    sessionID: SessionID
    agent: string
    model: NonNullable<Info["model"]>
    time: number
  }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly setShare: (input: { sessionID: SessionID; share: Info["share"] }) => Effect.Effect<void>
  readonly setWorkspace: (input: { sessionID: SessionID; workspaceID: Info["workspaceID"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  /**
   * Best-effort read-your-writes barrier. Flushes the coalesced part-update buffer and
   * awaits any in-flight flush so bulk readers (LLM history, HTTP reads) see the latest
   * parts. When `sessionID` is given, ONLY that session's pending parts are drained
   * (other sessions' parts stay buffered for a later global drain); when omitted, the
   * whole buffer is drained (previous behavior). Existing no-argument callers are
   * unchanged. Bounded retries (~3 attempts with short backoff) — it does NOT guarantee
   * durability: on persistent failures it leaves the buffer to the scheduled retry.
   * Resolves `true` when the buffer is empty after the attempts (read-your-writes
   * satisfied), `false` when parts are still buffered (the caller should warn — the
   * model may see a stale/empty history — but must not block the turn forever).
   */
  readonly flushNow: (sessionID?: SessionID) => Effect.Effect<boolean>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: SessionV1.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "share" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  share?: Partial<NonNullable<Info["share"]>> | null
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

const layer: Layer.Layer<
  Service,
  never,
  BackgroundJob.Service | RuntimeFlags.Service | Database.Service | EventV2Bridge.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    // Coalesced part updates. `updatePart` is called once per stream/tool chunk with the
    // full part payload; each call previously ran a full durable commit (event-log insert +
    // part upsert + sequence upsert in one SQLite transaction) and a `structuredClone`.
    // During a burst only the latest state of each part matters (the projector upserts whole
    // parts), so we debounce per part and persist every part once per short window.
    // NOTE: persistence happens at flush time, up to ~80ms after the last `updatePart`.
    // A crash inside that window can lose the part's latest state (the previous state that
    // was already flushed stays durable). This is the accepted tradeoff that makes streaming
    // chunks cheaper than one durable transaction per chunk.
    const PART_FLUSH_INTERVAL = 80 // ms
    const PART_FLUSH_BACKOFF = 100 // ms, pause between flushNow attempts
    // Exponential backoff for the detached retry chain, base → cap:
    // 250ms → 500ms → 1s → 2s → 5s → 10s. The index advances each time a retry is
    // scheduled and resets to 0 on the first successful drain, so a long DB outage never
    // retries every 250ms forever (and never exceeds the 10s cap).
    const PART_FLUSH_RETRY_DELAYS = [250, 500, 1_000, 2_000, 5_000, 10_000] // ms
    const pendingParts = new Map<string, { part: SessionV1.Part; time: number; eventId: EventV2.ID }>()
    let flushFiber: Fiber.Fiber<void, never> | undefined = undefined
    // Single-flight barrier: at most one flush drains the buffer at a time. Concurrent
    // callers (the 80ms debounce, flushNow, the retry, removePart) await the in-flight
    // flush's barrier and re-check the buffer afterwards instead of draining concurrently.
    let flushBarrier: Deferred.Deferred<void> | undefined = undefined
    // True while a detached retry is scheduled (sleeping or running). A failed flush
    // only schedules a retry when this is false, so a failure never spawns more than one
    // retry, no matter how many callers observe it.
    let retryScheduled = false
    let retryDelayIndex = 0
    // Tombstones for parts removed via removePart. Once a PartRemoved is published, a
    // later updatePart for the same key must NOT re-buffer a PartUpdated — the projector
    // would resurrect the part. Keys are added before publishing PartRemoved (so an
    // updatePart racing the removal drops its update) and removed once the publish has
    // succeeded. PartID.ascending() never reuses an id, so a key leaving this set is not
    // expected to be updated again by the processor.
    const removedPartKeys = new Set<string>()

    const partKey = (part: SessionV1.Part) => `${part.sessionID}:${part.messageID}:${part.id}`

    // Number of buffered parts, optionally scoped to a single session. The scoped form is
    // what lets flushNow(sessionID)/remove(sessionID) drain ONLY that session's parts and
    // still tell "empty for me" apart from "empty globally" without touching other
    // sessions' entries.
    const countPending = (sessionID?: SessionID) =>
      sessionID === undefined
        ? pendingParts.size
        : Array.from(pendingParts.values()).filter((entry) => entry.part.sessionID === sessionID).length

    const hasPending = (sessionID?: SessionID) => countPending(sessionID) > 0

    const flushPendingParts: (sessionID?: SessionID) => Effect.Effect<void, never, never> = Effect.fn(
      "Session.flushPendingParts",
    )(function* (sessionID?: SessionID) {
      // Serialize: if another flush is already running, wait for it and then re-check the
      // buffer. The drain loop of the in-flight flush keeps re-snapshotting, so entries added
      // while it ran are covered either by it or by us becoming the next owner.
      let inFlight = flushBarrier
      while (inFlight) {
        yield* Deferred.await(inFlight).pipe(Effect.ignore)
        if (!hasPending(sessionID)) return
        inFlight = flushBarrier
      }
      const barrier = yield* Deferred.make<void>()
      flushBarrier = barrier
      try {
        // Drain the buffer. Each iteration snapshots the pending entries, clears the map and
        // publishes one batch per session. Entries only leave the buffer after a successful
        // publish; on failure they are restored (with their original event id) and a retry
        // with a short backoff is scheduled, so a failed flush never drops an update and a
        // retry reuses the same event id instead of committing a duplicate event.
        while (hasPending(sessionID)) {
          // A session-scoped drain (flushNow(sessionID)) snapshots and removes only that
          // session's entries: other sessions' parts stay buffered for a later global drain
          // and are never lost by this pass.
          const entries =
            sessionID === undefined
              ? Array.from(pendingParts.entries())
              : Array.from(pendingParts.entries()).filter(([, entry]) => entry.part.sessionID === sessionID)
          if (entries.length === 0) break
          if (sessionID === undefined) {
            pendingParts.clear()
          } else {
            for (const [key] of entries) pendingParts.delete(key)
          }
          // The iteration body is wrapped in catchDefect so a defect between the
          // snapshot+clear above and the restore below can never lose the snapshot: the
          // whole batch is re-buffered (keep-newest) before the defect is rethrown.
          // `publishBatch` requires every durable event in one batch to share a single
          // aggregate (session), otherwise `commitDurableEvents` dies with
          // "Batch durable events must share a single aggregate". The `pendingParts` map
          // is shared across sessions, so group the pending updates by session before
          // publishing.
          const failed = yield* Effect.gen(function* () {
            const bySession = new Map<string, (typeof entries)[number][]>()
            for (const entry of entries) {
              const entrySessionID = entry[1].part.sessionID
              const group = bySession.get(entrySessionID)
              if (group) group.push(entry)
              else bySession.set(entrySessionID, [entry])
            }
            // Iterate the groups in a fixed order and track where we stopped. If a group's
            // publish fails, EVERY group from that one onward must be restored: the
            // snapshot above already cleared them all from the map, so committing only the
            // preceding groups and returning would silently drop the still-unprocessed
            // groups. Each entry is restored keep-newest with its original event id, so a
            // retry reuses the same durable ids instead of committing duplicates.
            const groups = Array.from(bySession.values())
            for (let i = 0; i < groups.length; i++) {
              const group = groups[i]
              const result = yield* events
                .publishBatch(
                  group.map(([, { part, time, eventId }]) => ({
                    definition: SessionV1.Event.PartUpdated,
                    // Reuse the id allocated at buffer time (updatePart) so every attempt of
                    // the same buffered content produces the same durable event id: a retry
                    // can never commit a duplicate event or double-notify subscribers.
                    options: { id: eventId },
                    // Parts are snapshotted (structuredClone) once at buffer time by
                    // updatePart, so the buffered object is immutable and can be delivered
                    // as-is — no clone here, so the drain has no synchronous throw point.
                    data: { sessionID: part.sessionID, part, time },
                  })),
                )
                .pipe(Effect.exit)
              if (Exit.isFailure(result)) {
                for (let j = i; j < groups.length; j++) {
                  for (const [key, entry] of groups[j]) {
                    // Keep the newest state if a newer update landed during the failed publish.
                    if (!pendingParts.has(key)) pendingParts.set(key, entry)
                  }
                }
                yield* Effect.logWarning("Session.flushPendingParts failed, scheduling retry", {
                  batch: entries.length,
                })
                // At most one detached retry per failure: while a retry is scheduled (sleeping
                // or running) no other failure may schedule another. The retry clears the
                // flag just before running so a failure of the retry itself schedules the
                // next one, and its finalizer (ensuring) clears it again so an interrupt or
                // shutdown during the sleep cannot leave retryScheduled stuck true.
                if (!retryScheduled) {
                  retryScheduled = true
                  yield* Effect.forkDetach(
                    Effect.sleep(`${PART_FLUSH_RETRY_DELAYS[retryDelayIndex]} millis`).pipe(
                      Effect.andThen(
                        Effect.gen(function* () {
                          retryScheduled = false
                          yield* flushPendingParts()
                        }),
                      ),
                      Effect.ensuring(
                        Effect.sync(() => {
                          retryScheduled = false
                        }),
                      ),
                    ),
                  )
                  retryDelayIndex = Math.min(retryDelayIndex + 1, PART_FLUSH_RETRY_DELAYS.length - 1)
                }
                return true
              }
            }
            return false
          }).pipe(
            Effect.catchDefect((defect) => {
              // Defect-safety: restore the whole snapshot keep-newest before rethrowing,
              // so an abnormal exit between snapshot+clear and the restore path never
              // drops buffered updates silently.
              for (const [key, entry] of entries) {
                if (!pendingParts.has(key)) pendingParts.set(key, entry)
              }
              return Effect.die(defect)
            }),
          )
          if (failed) break
        }
        if (pendingParts.size === 0) retryDelayIndex = 0
      } finally {
        flushBarrier = undefined
        yield* Deferred.succeed(barrier, undefined).pipe(Effect.ignore)
      }
    })

    const schedulePartFlush = Effect.fn("Session.schedulePartFlush")(function* () {
      if (flushFiber) return
      flushFiber = yield* Effect.forkDetach(
        Effect.sleep(`${PART_FLUSH_INTERVAL} millis`).pipe(
          Effect.andThen(() => flushPendingParts()),
          Effect.ensuring(
            Effect.sync(() => {
              flushFiber = undefined
            }),
          ),
        ),
      )
    })

    yield* Effect.addFinalizer(() => flushPendingParts())

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? (input.parentID ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString(),
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      yield* Effect.logInfo("created", result)

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(db, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        ...input,
      })
    })

    const listGlobal = Effect.fn("Session.listGlobal")(function* (input?: GlobalListInput) {
      const conditions: SQL[] = []
      if (input?.directory) conditions.push(eq(SessionTable.directory, input.directory))
      if (input?.roots) conditions.push(isNull(SessionTable.parent_id))
      if (input?.start) conditions.push(gte(SessionTable.time_updated, input.start))
      if (input?.cursor) conditions.push(lt(SessionTable.time_updated, input.cursor))
      if (input?.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
      if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))

      const query =
        conditions.length > 0
          ? db
              .select()
              .from(SessionTable)
              .where(and(...conditions))
          : db.select().from(SessionTable)
      const rows = yield* query
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(input?.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      const ids = [...new Set(rows.map((row) => row.project_id))]
      const projects = new Map<string, ProjectInfo>()
      if (ids.length > 0) {
        const items = yield* db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(inArray(ProjectTable.id, ids))
          .all()
          .pipe(Effect.orDie)
        for (const item of items) {
          projects.set(item.id, {
            id: item.id,
            name: item.name ?? undefined,
            worktree: item.worktree,
          })
        }
      }
      return rows.map((row) => ({ ...fromRow(row), project: projects.get(row.project_id) ?? null }))
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      try {
        // `remove` needs to work in all cases, such as broken sessions that
        // run cleanup without instance state.
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        // Drain the session's buffered parts BEFORE tearing the event log down: a pending
        // part left behind would be published by a later flush (80ms debounce or retry),
        // recreating the event log of a session that was just removed.
        // (a) Wait out ANY in-flight flush first: its drain may have already snapshotted
        //     this session's parts, so its PartUpdated must commit (or fail and restore)
        //     before we decide anything — the restore path would otherwise re-buffer keys
        //     we thought we removed.
        let inFlight = flushBarrier
        while (inFlight) {
          yield* Deferred.await(inFlight).pipe(Effect.ignore)
          inFlight = flushBarrier
        }
        // (b) Remove every pending key of the session so no future flush can publish it.
        for (const [key, entry] of pendingParts) {
          if (entry.part.sessionID === sessionID) pendingParts.delete(key)
        }
        // (c) Confirm nothing is left buffered for the session. If a racing updatePart
        //     re-buffered a part and the drain fails, ABORT the removal: deleting the
        //     event log with pending residue would let a later flush recreate it.
        if (!(yield* flushNow(sessionID))) {
          yield* Effect.logError("Session.remove: aborting removal, pending parts could not be flushed", {
            sessionID,
          })
          return
        }

        yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: session })
        yield* events.remove(sessionID)
      } catch (error) {
        yield* Effect.logError("failed to remove session", { sessionID, error })
      }
    })

    const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: msg.sessionID, info: msg })
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        // A part removed via removePart must not be re-buffered: an updatePart landing
        // after PartRemoved was published would resurrect the part in the projector.
        const key = partKey(part)
        if (removedPartKeys.has(key)) {
          yield* Effect.logDebug("Session.updatePart: dropping update for removed part", { key })
          return part
        }
        // Buffer the update and allocate its durable event id once, here: every attempt to
        // flush this buffered version reuses this id, so retries can never commit a
        // duplicate PartUpdated (see flushPendingParts). Persistence happens on the next
        // flush (~80ms debounce); a crash inside that window loses the part's latest state.
        // The part is snapshotted (structuredClone) at buffer time so the buffer holds an
        // immutable copy: the drain delivers it as-is and never clones again, removing the
        // synchronous-throw point that could abandon a drain with the map already cleared
        // (see the catchDefect in flushPendingParts).
        pendingParts.set(key, { part: structuredClone(part), time: Date.now(), eventId: EventV2.ID.create() })
        yield* schedulePartFlush()
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const flushNow: Interface["flushNow"] = Effect.fn("Session.flushNow")(function* (sessionID?: SessionID) {
      // Best-effort read-your-writes for bulk readers. `updatePart` buffers parts to
      // coalesce streaming chunks, and bulk reads (MessageV2.page/hydrate — the run loop's
      // LLM history, HTTP session reads) go straight to the DB, which never sees the buffer.
      // Flush synchronously and await any in-flight flush so a prompt saved moments ago
      // (e.g. a subagent's first message) is durable before the next DB read. Only drains
      // when the buffer is non-empty, so streaming coalescing is preserved. When `sessionID`
      // is given, ONLY that session's pending parts are drained — other sessions' parts stay
      // buffered and are still covered by the scheduled retry.
      // Bounded, NOT guaranteed-durable: `flushPendingParts` restores the buffer on failure
      // (never fails), so this retries at most MAX_ATTEMPTS times with a short pause and
      // then gives up with a warning — durability is left to the scheduled retry. Returns
      // true only when the buffer is empty afterwards; false signals that history built
      // from this point may be stale, so callers can warn (and possibly retry once).
      // This deliberately avoids the old busy-loop that spawned one detached retry per
      // iteration when the DB rejected the batch.
      const MAX_ATTEMPTS = 3
      let attempts = 0
      while (true) {
        if (!hasPending(sessionID) && !flushBarrier) return true
        attempts += 1
        yield* flushPendingParts(sessionID)
        if (!hasPending(sessionID)) return true
        if (attempts >= MAX_ATTEMPTS) {
          yield* Effect.logWarning("Session.flushNow: parts still buffered after 3 attempts; leaving the scheduled retry to persist them", {
            pending: countPending(sessionID),
            "session.id": sessionID,
          })
          return false
        }
        yield* Effect.sleep(`${PART_FLUSH_BACKOFF} millis`)
      }
    })

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      // Read-through: an updatePart that has not been flushed yet must be visible to reads,
      // otherwise the processor's tool-call dedup (ensureToolCall/readToolCall) misses the
      // part and creates a second part with the same tool_call_id.
      const pending = pendingParts.get(`${input.sessionID}:${input.messageID}:${input.partID}`)
      // Return a copy, never the live buffered object: callers (the processor's tool-call
      // dedup) hold the part across stream chunks and must not corrupt the buffer that the
      // next flush snapshot is built from.
      if (pending) return structuredClone(pending.part)
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as SessionV1.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      workspaceID?: WorkspaceV2.ID
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        parentID: input?.parentID,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        workspaceID: original.workspaceID,
        title,
        metadata: structuredClone(original.metadata),
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()
      const target = input.messageID ? msgs.findIndex((msg) => msg.info.id === input.messageID) : msgs.length

      for (const msg of msgs.slice(0, target < 0 ? msgs.length : target)) {
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = yield* updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          const p: SessionV1.Part = {
            ...part,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          }
          if (p.type === "compaction" && p.tail_start_id) {
            p.tail_start_id = idMap.get(p.tail_start_id)
          }
          yield* updatePart(p)
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          share: info.share === null ? undefined : info.share ? { ...current.share, ...info.share } : current.share,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (input: typeof SetMetadataInput.Type) {
      yield* patch(input.sessionID, { metadata: input.metadata, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setAgentModel = Effect.fn("Session.setAgentModel")(function* (input: {
      sessionID: SessionID
      agent: string
      model: NonNullable<Info["model"]>
      time: number
    }) {
      yield* patch(input.sessionID, {
        agent: input.agent,
        model: input.model,
        time: { updated: input.time },
      }).pipe(Effect.orDie)
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    const setShare = Effect.fn("Session.setShare")(function* (input: { sessionID: SessionID; share: Info["share"] }) {
      yield* patch(input.sessionID, { share: input.share ?? null, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      yield* patch(input.sessionID, { workspaceID: input.workspaceID, time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      void sessionID
      return [] as Snapshot.FileDiff[]
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      // Read-your-writes choke point: every reader that goes through Session.messages
      // (HTTP handlers, fork, SessionSummary.summarize, compaction.prune, revert,
      // ShareNext.full, the run-loop helpers) reads the DB directly and would otherwise
      // miss parts still sitting in the coalescing buffer — yielding empty/stale step
      // diffs non-deterministically (a regression of the streaming buffer). Flushing here
      // is a no-op when the buffer is empty (streaming coalescing preserved) and cannot
      // recurse: flushNow never reads messages.
      if (!(yield* flushNow(input.sessionID))) {
        yield* Effect.logWarning("Session.messages: flush failed, returning possibly stale messages", {
          "session.id": input.sessionID,
        })
      }
      if (input.limit) {
        return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).pipe(
          Effect.provideService(Database.Service, database),
        )).items
      }

      const size = 50
      const result = [] as SessionV1.WithParts[]
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item) result.push(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return result.reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      // Same ordering guarantee as removePart below: no PartUpdated for any part of this
      // message may commit after its MessageRemoved, or the projector would resurrect the
      // parts under a deleted message.
      // 0. Tombstone every currently-buffered key of the message first: any updatePart
      //    whose tombstone check runs after this point drops the update instead of
      //    re-buffering, so no PartUpdated can land after the MessageRemoved below.
      const keys = new Set<string>()
      const collectBufferedKeys = () => {
        for (const [key, entry] of pendingParts) {
          if (entry.part.sessionID === input.sessionID && entry.part.messageID === input.messageID) {
            removedPartKeys.add(key)
            keys.add(key)
          }
        }
      }
      collectBufferedKeys()
      // 1. Drop the still-buffered updates so a future flush cannot publish them.
      for (const key of keys) pendingParts.delete(key)
      // 2. Wait out ANY in-flight flush (of any caller — debounce, flushNow, retry). Its
      //    drain may have already snapshotted one of these parts, so its PartUpdated must
      //    commit before we publish MessageRemoved. A failed flush restores entries and
      //    schedules a retry, and an updatePart racing the removal could buffer a new key,
      //    so re-collect and drop again until no flush is in flight — the scheduled retry
      //    drains the map fresh and must never see these keys.
      let inFlight = flushBarrier
      while (inFlight) {
        yield* Deferred.await(inFlight).pipe(Effect.ignore)
        collectBufferedKeys()
        for (const key of keys) pendingParts.delete(key)
        inFlight = flushBarrier
      }
      // 3. No flush is in flight and the keys are not buffered; any flush that starts now
      //    snapshots the map without them, so MessageRemoved is its last event.
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      // 4. MessageRemoved is durable: forget the tombstones. PartID.ascending() never
      //    reuses an id, so the processor cannot legitimately recreate these parts; a
      //    hypothetical updatePart for one of these keys after this point is treated as a
      //    brand-new part.
      for (const key of keys) removedPartKeys.delete(key)
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      const key = `${input.sessionID}:${input.messageID}:${input.partID}`
      // Ordering: no PartUpdated for a removed part may commit after its PartRemoved.
      // 0. Tombstone the key first: any updatePart whose tombstone check runs after this
      //    point drops the update instead of re-buffering, so no PartUpdated can land
      //    after the PartRemoved below. (updatePart's check+set is atomic — no yield*
      //    between them — so there is no window where a racing update slips through.)
      removedPartKeys.add(key)
      // 1. Drop any still-buffered update so a future flush cannot publish it.
      pendingParts.delete(key)
      // 2. Wait out ANY in-flight flush (of any caller — debounce, flushNow, retry). Its
      //    drain may have already snapshotted this part, so its PartUpdated must commit
      //    before we publish PartRemoved. A failed flush restores entries and schedules a
      //    retry, so keep looping until no flush is in flight, dropping the key again each
      //    time — the scheduled retry drains the map fresh and must never see this key.
      let inFlight = flushBarrier
      while (inFlight) {
        yield* Deferred.await(inFlight).pipe(Effect.ignore)
        pendingParts.delete(key)
        inFlight = flushBarrier
      }
      // 3. No flush is in flight and the key is not buffered; any flush that starts now
      //    snapshots the map without this part, so PartRemoved is its last event.
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      // 4. PartRemoved is durable: forget the tombstone. PartID.ascending() never reuses
      //    an id, so the processor cannot legitimately recreate this part; a hypothetical
      //    updatePart for the key after this point is treated as a brand-new part.
      removedPartKeys.delete(key)
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      // Non-durable live delta, published once per stream chunk and never persisted. It can
      // be delivered BEFORE the corresponding PartUpdated (which is buffered by updatePart
      // and only flushed on the ~80ms debounce), so consumers must handle delta-before-part:
      // apply the delta to whatever part state they currently hold, or ignore it until the
      // part arrives. The durable part state only ever reflects the last updatePart.
      yield* events.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<SessionV1.WithParts>()
    })

    return Service.of({
      list,
      listGlobal,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setMetadata,
      setAgentModel,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      setShare,
      setWorkspace,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      flushNow,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function listByProject(
  db: Database.Interface["db"],
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project") {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  return db
    .select()
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(fromRow)),
    )
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, RuntimeFlags.node, Database.node, EventV2Bridge.node],
})

export * as Session from "./session"
