// packages/mcp-server/src/progress.ts
//
// Bridges the workflow engine's progress callback onto the MCP wire. The engine drives a
// SYNCHRONOUS run inside one tools/call; the ONLY in-flight signal back to the client is
// `notifications/progress`. MCP correlates a progress notification to the originating
// request via the `progressToken` the client put on `tools/call._meta` — so when no token
// was sent there is nothing to correlate to and we MUST stay silent (skip), not invent one.
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * The progress sink the shell hands to the engine. The engine calls it as it advances
 * through the run; `total` (planned units) and `message` are optional. Mirrors the engine
 * `onProgress(progress, total?, message?)` shape.
 */
export type WorkflowProgressCallback = (progress: number, total?: number, message?: string) => void;

/** The `extra` bag the SDK passes to a tool handler: progress sink + AbortSignal + request `_meta`. */
export type WorkflowToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Build the engine `onProgress` sink for ONE tool call. Progress flows only when the client
 * attached `_meta.progressToken` to its `tools/call`; otherwise we return a no-op so the run
 * still proceeds but emits nothing. Notifications are advisory and fire-and-forget — a closed
 * or failing transport must never abort the workflow.
 */
export function createProgressReporter(extra: WorkflowToolExtra): WorkflowProgressCallback {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return () => {
      /* no progressToken on this call -> progress is not addressable; intentionally skip. */
    };
  }
  return (progress, total, message) => {
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      })
      .catch(() => {
        /* advisory channel: swallow notification/transport errors so the run is unaffected. */
      });
  };
}
