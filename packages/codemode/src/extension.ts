export * as Extension from "./extension.js"

import type { Effect } from "effect"

/**
 * Host functions a program calls directly as globals. Values crossing in either direction are converted, never
 * shared: arguments come in as copies, results go out as copies, and a function inside a result is callable the
 * same way. Extension calls are not tool calls. A global may return a value, a Promise, or an Effect; an Effect runs
 * only after the extension hooks admit the call, and its requirements join the runtime's environment.
 */
export type Extension<Globals extends Readonly<Record<string, Function>> = Readonly<Record<string, Function>>> = {
  readonly name: string
  readonly globals: Globals
}

/** The Effect environment required by an extension's Effect-returning globals. */
export type Services<E> = E extends { readonly globals: infer Globals }
  ? Globals[keyof Globals] extends infer Global
    ? Global extends (...args: never) => infer Result
      ? Effect.Services<Result>
      : never
    : never
  : never

export const make = <const Globals extends Readonly<Record<string, Function>>>(
  options: Extension<Globals>,
): Extension<Globals> => {
  for (const [name, value] of Object.entries(options.globals)) {
    if (typeof value !== "function") {
      throw new TypeError(`Extension "${options.name}" global "${name}" must be a function.`)
    }
  }
  return { name: options.name, globals: { ...options.globals } }
}
