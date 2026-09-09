import assert from "node:assert/strict";
import test from "node:test";

import { McpServer, type ServerContext } from "@modelcontextprotocol/server";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";
import { CapabilityAwareToolCatalog } from "../src/tool-catalog.js";

function context(capabilities?: Record<string, unknown>): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method: "tools/list",
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: async () => ({}),
      notify: async () => undefined,
      log: async () => undefined,
      elicitInput: async () => ({ action: "cancel" }),
      requestSampling: async () => ({ model: "", role: "assistant", content: { type: "text", text: "" } }),
      ...(capabilities === undefined
        ? {}
        : {
            envelope: {
              "io.modelcontextprotocol/clientCapabilities": capabilities,
            },
          }),
    },
  } as unknown as ServerContext;
}

const matching = { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } };

test("modern Apps decisions are request-scoped while legacy ignores envelope lookalikes", () => {
  const modernServer = new McpServer({ name: "modern", version: "1" }, { capabilities: { tools: {} } });
  const modern = new CapabilityAwareToolCatalog(modernServer, "modern");
  assert.equal(modern.supportsApps(context(matching)), true);
  assert.equal(modern.supportsApps(context({})), false);
  assert.equal(modern.supportsApps(context(matching)), true, "an incapable request did not poison the next request");

  const legacyServer = new McpServer({ name: "legacy", version: "1" }, { capabilities: { tools: {} } });
  const legacy = new CapabilityAwareToolCatalog(legacyServer, "legacy");
  legacy.setLegacyCapabilities({});
  assert.equal(
    legacy.supportsApps(context(matching)),
    false,
    "legacy capability comes only from initialize, never a request envelope lookalike",
  );
  legacy.setLegacyCapabilities(matching);
  assert.equal(legacy.supportsApps(context({})), true);
});

// Exercise the catalog's installed projection and call wrappers with real v2 registrations.
// Capturing only public registration methods avoids a v1 object or private SDK map seam.
for (const era of ["legacy", "modern"] as const) {
  test(`${era} Apps discovery and invocation preserve the dedicated monitor boundary`, async () => {
    const { registerWorkflowAppUi, WORKFLOW_MONITOR_TOOL_NAME, WORKFLOW_EVENTS_TOOL_NAME, WORKFLOW_RUNS_TOOL_NAME, WORKFLOW_NOTIFICATIONS_TOOL_NAME, RUN_MONITOR_RESOURCE_URI } = await import("../src/app-ui.js");
    const { z } = await import("zod");
    const server = new McpServer({ name: `catalog-${era}`, version: "1" }, { capabilities: { tools: {} } });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const nativeRegister = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
      return nativeRegister(name, config as never, handler as never);
    }) as typeof server.registerTool;
    const catalog = new CapabilityAwareToolCatalog(server, era);
    const nativeSet = server.server.setRequestHandler.bind(server.server);
    let list: ((_request: unknown, ctx: ServerContext) => Promise<{ tools: Array<{ name: string; _meta?: unknown }> }>) | undefined;
    server.server.setRequestHandler = ((method: unknown, handler: (...args: unknown[]) => unknown) => {
      if (method === "tools/list") list = handler as typeof list;
      return nativeSet(method as never, handler as never);
    }) as typeof server.server.setRequestHandler;
    server.registerTool("workflow", { inputSchema: z.object({ action: z.literal("status") }) }, () => ({ content: [] }));
    registerWorkflowAppUi(server, {
      openMonitor: (runId) => ({ runId, status: "pending", scriptUri: `workflow://runs/${runId}/script` }),
      notification: () => ({ send: false }),
      readEventsPage: () => { throw new Error("Not used in this registration test"); },
      listRecentRuns: () => [],
      registerResourceReader: () => undefined,
    });
    catalog.installListHandler();
    assert.ok(list);
    const support = [WORKFLOW_MONITOR_TOOL_NAME, WORKFLOW_EVENTS_TOOL_NAME, WORKFLOW_RUNS_TOOL_NAME, WORKFLOW_NOTIFICATIONS_TOOL_NAME];
    for (const capable of [true, false, true]) {
      if (era === "legacy") catalog.setLegacyCapabilities(capable ? matching : {});
      const ctx = context(capable ? matching : {});
      const result = await list({ method: "tools/list" }, ctx);
      assert.deepEqual(result.tools.map((tool) => tool.name).sort(), (capable ? ["workflow", ...support] : ["workflow"]).sort());
      assert.equal(result.tools.find((tool) => tool.name === "workflow")?._meta, undefined);
      if (capable) {
        assert.deepEqual(result.tools.find((tool) => tool.name === WORKFLOW_MONITOR_TOOL_NAME)?._meta, { ui: { resourceUri: RUN_MONITOR_RESOURCE_URI } });
        for (const name of support.slice(1)) assert.deepEqual(result.tools.find((tool) => tool.name === name)?._meta, { ui: { visibility: ["app"] } });
        const opened = await handlers.get(WORKFLOW_MONITOR_TOOL_NAME)!({ runId: "run-a" }, ctx) as { structuredContent: { runId: string } };
        assert.equal(opened.structuredContent.runId, "run-a");
      } else {
        for (const name of support) {
          assert.throws(() => handlers.get(name)!({ runId: "run-a" }, ctx), /advertise MCP Apps support/);
        }
      }
    }
    await server.close();
  });
}
