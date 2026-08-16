import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// Intermediate process: spawn a persistent leaf, publish both pids, then wait.
// The test SIGKILLs this process to force the leaf to be reparented while it
// stays in the server's process group.
if (process.argv.includes("--middle")) {
  const leaf = spawn("sleep", ["1000"], { stdio: "ignore" })
  writeFileSync(process.env.MCP_TREE_LEAF_PID_FILE!, String(leaf.pid))
  writeFileSync(process.env.MCP_TREE_MIDDLE_PID_FILE!, String(process.pid))
  await new Promise(() => {})
}

// Main stdio server (process-group leader when spawned via setsid): publish
// our own pid, spawn the intermediate, then serve the MCP protocol.
if (process.env.MCP_TREE_SERVER_PID_FILE) {
  writeFileSync(process.env.MCP_TREE_SERVER_PID_FILE, String(process.pid))
  const middle = spawn(process.execPath, [import.meta.path, "--middle"], {
    stdio: "ignore",
    env: {
      ...process.env,
      MCP_TREE_LEAF_PID_FILE: process.env.MCP_TREE_LEAF_PID_FILE,
      MCP_TREE_MIDDLE_PID_FILE: process.env.MCP_TREE_MIDDLE_PID_FILE,
    },
  })
  middle.unref()
}

const server = new Server({ name: "mcp-tree-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
