#!/usr/bin/env node
// Stdio entry point under its own executable name. `npm link` (or a global
// install from a clone) puts `repo-notebook-mcp` on PATH, so MCP clients and
// policy tools can identify this server without matching a generic `node`.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRepoNotebookMcpServer } from "../mcp/server.js";

const server = createRepoNotebookMcpServer();
await server.connect(new StdioServerTransport());
