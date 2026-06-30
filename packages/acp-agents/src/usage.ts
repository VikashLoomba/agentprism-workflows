// ACP usage -> the engine's AgentUsage. The runner reads usage from two ACP channels
// (both UNSTABLE/experimental in @agentclientprotocol/sdk@1.0.0): the per-turn
// PromptResponse.usage object and the streamed usage_update session notification. We
// tolerate either, both, or NEITHER firing — `total === 0` is the "provider reported
// nothing" sentinel the engine reads (it then falls back to a chars/4 estimate).
//
// Field mapping (frozen contract, agent-run.ts AgentUsage doc):
//   input      <- inputTokens          output     <- outputTokens
//   cacheRead  <- cachedReadTokens ?? 0 cacheWrite <- cachedWriteTokens ?? 0
//   total      <- totalTokens ?? 0      cost       <- Claude: usage_update.cost.amount (USD);
//                                                     Codex: 0 (no dollar cost reported)
import type { AgentUsage } from "@agentprism/shared-types";
import type { Cost, Usage } from "@agentclientprotocol/sdk";

export class UsageAccumulator {
  private promptUsage: Usage | undefined;
  private costAmount = 0;

  /** Record the authoritative per-turn token usage from a PromptResponse. */
  recordPromptUsage(usage: Usage | null | undefined): void {
    if (usage) this.promptUsage = usage;
  }

  /** Record the latest cumulative dollar cost carried by a usage_update notification. */
  recordCost(cost: Cost | null | undefined): void {
    if (cost && typeof cost.amount === "number" && Number.isFinite(cost.amount)) {
      this.costAmount = cost.amount;
    }
  }

  toAgentUsage(): AgentUsage {
    const u = this.promptUsage;
    return {
      input: u?.inputTokens ?? 0,
      output: u?.outputTokens ?? 0,
      cacheRead: u?.cachedReadTokens ?? 0,
      cacheWrite: u?.cachedWriteTokens ?? 0,
      total: u?.totalTokens ?? 0,
      cost: this.costAmount,
    };
  }
}
