#!/usr/bin/env node
// @automatalabs/mcp-server — the shell / composition root: it consumes the
// @automatalabs/workflows SDK (the canonical programmatic core) for both the ACP-backed
// AgentRunner and the WorkflowManager engine. The runner is injected into the engine
// (createWorkflowServer(createAcpRunner())) and the resulting MCP server is connected over
// stdio. stdout is RESERVED for JSON-RPC framing — every diagnostic goes to stderr.
import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAcpRunner } from "@automatalabs/workflows";

import { createWorkflowServer } from "./server.js";

export { createWorkflowServer } from "./server.js";
export type { WorkflowConfirmCallback, WorkflowCheckpointOptions } from "./server.js";
export { clampWorkflowInput, workflowToolInputShape } from "./workflow-tool-input.js";
export type { WorkflowToolInput } from "./workflow-tool-input.js";
export { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
export type { WorkflowToolResult } from "./workflow-tool-output.js";
export { createProgressReporter } from "./progress.js";
export type { WorkflowProgressCallback, WorkflowToolExtra } from "./progress.js";

/**
 * Bootstrap the MCP `workflow` server over stdio. Composition root: build the ACP-backed
 * AgentRunner, inject it into the workflow-engine via the server shell, and serve on stdin/stdout.
 */
export async function main(): Promise<void> {
  const runner = createAcpRunner();
  const server = createWorkflowServer(runner);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run as the `agentprism-workflow` executable, but stay import-safe as a library: only start
// the stdio server when this module is the process entry point.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error("[agentprism-workflow] fatal error during startup:", error);
    process.exitCode = 1;
  });
}
