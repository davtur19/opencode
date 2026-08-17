import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * Orchestrator read gate. Must mirror the `agent.orchestrator.permission.read`
 * (and `agent.orchestrator-goal.permission.read`) block in the agent config.
 *
 * Order is significant: the deny default comes FIRST; the specific allow
 * patterns follow so that last-match-wins keeps them effective.
 */
const ORCHESTRATOR_READ_GATE = {
  "*": "deny",
  "AGENTS.md": "allow",
  "**/AGENTS.md": "allow",
  "opencode.json": "allow",
  "**/opencode.json": "allow",
  "opencode.jsonc": "allow",
  "**/opencode.jsonc": "allow",
  ".opencode/*.md": "allow",
  "**/.opencode/*.md": "allow",
  ".opencode/agent/*": "allow",
  "**/.opencode/agent/*": "allow",
} satisfies Record<string, "allow" | "deny">

const ORCHESTRATOR_TASK_GATE = {
  "*": "deny",
  subagent: "allow",
  vision: "allow",
  verifier: "allow",
} satisfies Record<string, "allow" | "deny">

const gate = Permission.fromConfig({ read: ORCHESTRATOR_READ_GATE })
const gateWithTask = Permission.fromConfig({
  read: ORCHESTRATOR_READ_GATE,
  task: ORCHESTRATOR_TASK_GATE,
})

const read = (pattern: string, ruleset: PermissionV1.Ruleset) =>
  Permission.evaluate("read", pattern, ruleset).action

describe("orchestrator read gate (policy evaluation)", () => {
  test("allows required instruction files", () => {
    expect(read("AGENTS.md", gate)).toBe("allow")
    expect(read("packages/opencode/AGENTS.md", gate)).toBe("allow")
    expect(read(".opencode/agent/orchestrator.md", gate)).toBe("allow")
    expect(read(".opencode/agent/orchestrator-goal.md", gate)).toBe("allow")
  })

  test("allows required orchestration config", () => {
    expect(read("opencode.json", gate)).toBe("allow")
    expect(read("opencode.jsonc", gate)).toBe("allow")
    expect(read(".opencode/opencode.jsonc", gate)).toBe("allow")
  })

  test("allows goal/coordination state files", () => {
    expect(read(".opencode/goal-state.md", gate)).toBe("allow")
    expect(read(".opencode/FAILURES.md", gate)).toBe("allow")
    expect(read(".opencode/PM_DECISION.md", gate)).toBe("allow")
  })

  test("denies source files (real observed paths)", () => {
    for (const p of [
      "packages/opencode/src/session/run-state.ts",
      "packages/opencode/src/session/boot-reconcile.ts",
      "packages/opencode/src/effect/runner.ts",
      "packages/opencode/src/tool/read.ts",
      "src/index.ts",
    ]) {
      expect(read(p, gate)).toBe("deny")
    }
  })

  test("denies test implementation files", () => {
    for (const p of [
      "packages/opencode/test/session/boot-reconcile.test.ts",
      "packages/opencode/test/tool/read.test.ts",
      "packages/opencode/test/permission/orchestrator-read-gate.test.ts",
    ]) {
      expect(read(p, gate)).toBe("deny")
    }
  })

  test("denies arbitrary project implementation files", () => {
    for (const p of [
      "packages/opencode/package.json",
      "README.md",
      "src/main.go",
      "scripts/build.sh",
    ]) {
      expect(read(p, gate)).toBe("deny")
    }
  })

  test("deny default is not bypassed when allow pattern is a prefix", () => {
    expect(read(".opencode/ton-audit/src/lib.rs", gate)).toBe("deny")
    expect(read(".opencode/node_modules/x/index.js", gate)).toBe("deny")
  })

  test("read tool is not disabled by the gate (path-gated, not global deny)", () => {
    expect(Permission.disabled(["read"], gate).has("read")).toBe(false)
  })
})

describe("orchestrator-goal has the same read restriction", () => {
  test("allows instruction/config reads and denies source/test reads", () => {
    expect(read("AGENTS.md", gate)).toBe("allow")
    expect(read("opencode.jsonc", gate)).toBe("allow")
    expect(read(".opencode/goal-state.md", gate)).toBe("allow")
    expect(read("packages/opencode/src/effect/runner.ts", gate)).toBe("deny")
    expect(read("packages/opencode/test/tool/read.test.ts", gate)).toBe("deny")
  })
})

describe("subagent and verifier read capabilities unchanged", () => {
  const subagent = Permission.fromConfig({ read: "allow" })
  const verifier = Permission.fromConfig({ read: "allow", grep: "allow", bash: "allow" })

  test("subagent can still read source and test files", () => {
    expect(read("packages/opencode/src/session/run-state.ts", subagent)).toBe("allow")
    expect(read("packages/opencode/test/tool/read.test.ts", subagent)).toBe("allow")
    expect(read("AGENTS.md", subagent)).toBe("allow")
  })

  test("verifier read behavior unchanged", () => {
    expect(read("packages/opencode/src/session/run-state.ts", verifier)).toBe("allow")
    expect(read("packages/opencode/test/session/boot-reconcile.test.ts", verifier)).toBe("allow")
  })
})

describe("blocked task() delegation does not authorize direct source inspection", () => {
  test("source reads stay denied even though delegation is blocked", () => {
    // delegation to non-subagent agents is blocked…
    expect(Permission.evaluate("task", "general", gateWithTask).action).toBe("deny")
    expect(Permission.evaluate("task", "explore", gateWithTask).action).toBe("deny")
    // …only subagent/vision/verifier delegation is allowed…
    expect(Permission.evaluate("task", "subagent", gateWithTask).action).toBe("allow")
    // …and a blocked task does NOT unlock direct source reads.
    expect(read("packages/opencode/src/session/run-state.ts", gateWithTask)).toBe("deny")
    expect(read("packages/opencode/src/session/boot-reconcile.ts", gateWithTask)).toBe("deny")
    expect(read("packages/opencode/src/effect/runner.ts", gateWithTask)).toBe("deny")
  })

  test("denied read surfaces as a DeniedError, not a silent allow", () => {
    const denyRead = () => {
      for (const pattern of ["packages/opencode/src/session/run-state.ts"]) {
        const rule = Permission.evaluate("read", pattern, gateWithTask)
        if (rule.action === "deny") {
          throw new PermissionV1.DeniedError({ ruleset: gateWithTask })
        }
      }
    }
    expect(denyRead).toThrow(PermissionV1.DeniedError)
  })
})

// ---------------------------------------------------------------------------
// Integration: agent config parsing + read tool enforcement on real paths
// ---------------------------------------------------------------------------

afterEach(async () => {
  await disposeAllInstances()
})

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Config.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const init = Effect.fn("ReadGateTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadGateTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadGateTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadGateTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const put = Effect.fn("ReadGateTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const agentConfig = (readGate: Record<string, "allow" | "deny">) => ({
  agent: {
    orchestrator: { mode: "primary" as const, permission: { read: readGate } },
    "orchestrator-goal": { mode: "primary" as const, permission: { read: readGate } },
  },
})

it.instance(
  "config parsing produces the orchestrator read gate and enforces real paths",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      const o = Permission.fromConfig(config.agent?.orchestrator?.permission ?? {})
      const og = Permission.fromConfig(config.agent?.["orchestrator-goal"]?.permission ?? {})

      expect(read("AGENTS.md", o)).toBe("allow")
      expect(read("opencode.jsonc", o)).toBe("allow")
      expect(read(".opencode/goal-state.md", o)).toBe("allow")
      expect(read("packages/opencode/src/session/run-state.ts", o)).toBe("deny")
      expect(read("packages/opencode/test/tool/read.test.ts", o)).toBe("deny")

      expect(read("AGENTS.md", og)).toBe("allow")
      expect(read("packages/opencode/src/effect/runner.ts", og)).toBe("deny")
    }),
  {
    git: true,
    config: () => agentConfig(ORCHESTRATOR_READ_GATE),
  },
)

it.live(
  "orchestrator agent from config: instruction read allowed, source read denied",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: () => agentConfig(ORCHESTRATOR_READ_GATE) })
      yield* put(path.join(dir, "AGENTS.md"), "# Rules\n")
      yield* put(path.join(dir, "packages", "opencode", "src", "session", "run-state.ts"), "export const x = 1\n")
      yield* put(path.join(dir, "packages", "opencode", "test", "tool", "read.test.ts"), "test('x', () => {})\n")

      const info = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const service = yield* Agent.Service
          return yield* service.get("orchestrator")
        }),
      )

      const next = {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        callID: "",
        agent: "orchestrator",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          Effect.sync(() => {
            for (const pattern of req.patterns) {
              const rule = Permission.evaluate(req.permission, pattern, info.permission)
              if (rule.action === "deny") {
                throw new PermissionV1.DeniedError({ ruleset: info.permission })
              }
            }
          }),
      }

      const ok = yield* exec(dir, { filePath: path.join(dir, "AGENTS.md") }, next)
      expect(ok.output).toContain("# Rules")

      const sourceErr = yield* fail(
        dir,
        { filePath: path.join(dir, "packages", "opencode", "src", "session", "run-state.ts") },
        next,
      )
      expect(sourceErr).toBeInstanceOf(PermissionV1.DeniedError)

      const testErr = yield* fail(
        dir,
        { filePath: path.join(dir, "packages", "opencode", "test", "tool", "read.test.ts") },
        next,
      )
      expect(testErr).toBeInstanceOf(PermissionV1.DeniedError)
    }),
)

it.live(
  "orchestrator-goal agent from config: instruction read allowed, source read denied",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: () => agentConfig(ORCHESTRATOR_READ_GATE) })
      yield* put(path.join(dir, "AGENTS.md"), "# Rules\n")
      yield* put(path.join(dir, "src", "secret.ts"), "shh\n")

      const info = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const service = yield* Agent.Service
          return yield* service.get("orchestrator-goal")
        }),
      )

      const next = {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        callID: "",
        agent: "orchestrator-goal",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          Effect.sync(() => {
            for (const pattern of req.patterns) {
              const rule = Permission.evaluate(req.permission, pattern, info.permission)
              if (rule.action === "deny") {
                throw new PermissionV1.DeniedError({ ruleset: info.permission })
              }
            }
          }),
      }

      const ok = yield* exec(dir, { filePath: path.join(dir, "AGENTS.md") }, next)
      expect(ok.output).toContain("# Rules")

      const err = yield* fail(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
)

it.live(
  "subagent from config can still read source and test files",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: () => ({ agent: { subagent: { mode: "subagent" as const } } }) })
      yield* put(path.join(dir, "packages", "opencode", "src", "session", "run-state.ts"), "export const x = 1\n")

      const info = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const service = yield* Agent.Service
          return yield* service.get("subagent")
        }),
      )

      const next = {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        callID: "",
        agent: "subagent",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          Effect.sync(() => {
            for (const pattern of req.patterns) {
              const rule = Permission.evaluate(req.permission, pattern, info.permission)
              if (rule.action === "deny") {
                throw new PermissionV1.DeniedError({ ruleset: info.permission })
              }
            }
          }),
      }

      const result = yield* exec(
        dir,
        { filePath: path.join(dir, "packages", "opencode", "src", "session", "run-state.ts") },
        next,
      )
      expect(result.output).toContain("export const x = 1")
    }),
)