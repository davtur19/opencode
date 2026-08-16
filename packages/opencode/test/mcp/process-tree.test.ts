import path from "node:path"
import { readFileSync } from "node:fs"
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const itLinux = process.platform === "linux" ? it.instance : it.instance.skip
const treeFixture = path.join(import.meta.dir, "../fixture/mcp-tree-stdio.ts")

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

function readPid(file: string): number | undefined {
  try {
    return Number(readFileSync(file, "utf8").trim())
  } catch {
    return undefined
  }
}

function statFields(pid: number): { ppid: number; pgrp: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]) }
  } catch {
    return undefined
  }
}

itLinux(
  "disconnect terminates reparented descendants via the process group",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const serverPidFile = path.join(test.directory, "server.pid")
      const middlePidFile = path.join(test.directory, "middle.pid")
      const leafPidFile = path.join(test.directory, "leaf.pid")
      const mcp = yield* MCP.Service

      const result = yield* mcp.add("tree", {
        type: "local",
        command: [process.execPath, treeFixture],
        environment: {
          MCP_TREE_SERVER_PID_FILE: serverPidFile,
          MCP_TREE_MIDDLE_PID_FILE: middlePidFile,
          MCP_TREE_LEAF_PID_FILE: leafPidFile,
        },
        timeout: 100,
      })
      expect(statusName(result.status, "tree")).toBe("connected")

      const serverPid = yield* pollWithTimeout(
        Effect.sync(() => readPid(serverPidFile)),
        "server did not publish its pid",
      )
      const middlePid = yield* pollWithTimeout(
        Effect.sync(() => readPid(middlePidFile)),
        "middle process did not publish its pid",
      )
      const leafPid = yield* pollWithTimeout(
        Effect.sync(() => readPid(leafPidFile)),
        "leaf process did not publish its pid",
      )

      // Leaf starts as a child of the intermediate, all in the server's process group.
      expect(statFields(leafPid)?.ppid).toBe(middlePid)
      expect(statFields(leafPid)?.pgrp).toBe(serverPid)

      // Kill the intermediate; the leaf is reparented but stays in the same
      // process group. A pgrep-based descendant walk would now miss it.
      process.kill(middlePid, "SIGKILL")
      yield* pollWithTimeout(
        Effect.sync(() => (statFields(leafPid)?.ppid !== middlePid ? true : undefined)),
        "leaf was not reparented",
      )
      expect(statFields(leafPid)?.pgrp).toBe(serverPid)

      // Disconnect runs terminateLocalMcp, which kills the whole process group.
      yield* mcp.disconnect("tree")

      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(leafPid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "reparented leaf was not terminated",
      )
    }),
)

itLinux(
  "local server teardown leaves no process group members behind",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const serverPidFile = path.join(test.directory, "server.pid")
      const middlePidFile = path.join(test.directory, "middle.pid")
      const leafPidFile = path.join(test.directory, "leaf.pid")
      const mcp = yield* MCP.Service

      yield* mcp.add("tree", {
        type: "local",
        command: [process.execPath, treeFixture],
        environment: {
          MCP_TREE_SERVER_PID_FILE: serverPidFile,
          MCP_TREE_MIDDLE_PID_FILE: middlePidFile,
          MCP_TREE_LEAF_PID_FILE: leafPidFile,
        },
        timeout: 100,
      })

      const leafPid = yield* pollWithTimeout(
        Effect.sync(() => readPid(leafPidFile)),
        "leaf process did not publish its pid",
      )

      yield* mcp.disconnect("tree")

      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(leafPid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "leaf was not terminated",
      )
    }),
)
