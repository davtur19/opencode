import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  // Guarantees the work runs exactly once, in FIFO order behind any active
  // run/shell, and resolves with that work's own result. Callers never share
  // another caller's run: sharing silently drops work (e.g. a background
  // subagent result injected while the parent turn is running) and leaves the
  // caller waiting on a stranger's result.
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E>; readonly queue: readonly PendingHandle<A, E>[] }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | {
      readonly _tag: "ShellThenRun"
      readonly shell: ShellHandle<A, E>
      readonly queue: readonly PendingHandle<A, E>[]
    }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  // Settles the finished run, then starts the next queued run if any. Goes idle
  // (and fires onIdle) only when the queue is empty: firing idle while work is
  // still queued would report the runner — and the session above it — as done
  // while a pending turn never runs.
  const finishRun = (id: number, done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        // Stale completion (e.g. a run whose runner was cancelled and replaced):
        // settle its waiter, never touch current state.
        if (st._tag !== "Running" || st.run.id !== id) {
          yield* complete(done, exit)
          return [undefined, st] as const
        }
        const [head, ...rest] = st.queue
        yield* complete(done, exit)
        if (!head) {
          yield* idle
          return [undefined, { _tag: "Idle" } as const] as const
        }
        const run = yield* startRun(head.work, head.done)
        return [undefined, { _tag: "Running", run, queue: rest }] as const
      }),
    ).pipe(Effect.asVoid)

  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<RunHandle<A, E>, never, never> =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          yield* idle
          return [undefined, { _tag: "Idle" } as const] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const [head, ...rest] = st.queue
          if (!head) {
            yield* idle
            return [undefined, { _tag: "Idle" } as const] as const
          }
          const run = yield* startRun(head.work, head.done)
          return [undefined, { _tag: "Running", run, queue: rest }] as const
        }
        return [undefined, st] as const
      }),
    ).pipe(Effect.asVoid)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  // A waiter interrupted while still queued must dequeue itself, otherwise its
  // orphaned handle would start a run nobody waits for once it reaches the head.
  // Runs unconditionally: removal is a no-op when the handle already started.
  const removeQueued = (id: number) =>
    SynchronizedRef.update(ref, (st) => {
      if (st._tag !== "Running" && st._tag !== "ShellThenRun") return st
      if (!st.queue.some((item) => item.id === id)) return st
      return { ...st, queue: st.queue.filter((item) => item.id !== id) }
    })

  const track = (id: number, done: Deferred.Deferred<A, E | Cancelled>) =>
    awaitDone(done).pipe(Effect.ensuring(removeQueued(id)))

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "ShellThenRun": {
            const pending = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [track(pending.id, pending.done), { ...st, queue: [...st.queue, pending] }] as const
          }
          case "Shell": {
            const pending = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [
              track(pending.id, pending.done),
              { _tag: "ShellThenRun", shell: st.shell, queue: [pending] },
            ] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [track(run.id, done), { _tag: "Running", run, queue: [] }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running": {
        const queued = st.queue
        return [
          Effect.gen(function* () {
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            // Queued waiters never start: settle them as cancelled so each
            // caller takes the same onInterrupt path as the running one.
            yield* Effect.forEach(queued, (item) => Deferred.fail(item.done, new Cancelled()), {
              discard: true,
            })
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      }
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun": {
        const queued = st.queue
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* Effect.forEach(queued, (item) => Deferred.fail(item.done, new Cancelled()), {
              discard: true,
            })
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      }
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    startShell,
    cancel,
  }
}

export * as Runner from "./runner"
