import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, AgentRunner, JournalEntry, RunOptions } from "@automatalabs/shared-types";
import { runWorkflow } from "../src/workflow.js";

// agent({ meta, promptMeta }) are ADDITIVE run inputs (the generic ACP `_meta` passthroughs):
// the engine must thread them through to the runner opts verbatim (the runner merges them into
// ACP session/new / session/prompt `_meta`), but they must NOT enter the resume identity hash
// (hashAgentCall) — they shape the agent, not the logical call, exactly like mcpServers.

describe("agent({ meta, promptMeta }) plumbing", () => {
  it("threads meta and promptMeta from agent() into the runner opts", async () => {
    let meta: Record<string, unknown> | undefined;
    let promptMeta: Record<string, unknown> | undefined;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        meta = options?.meta;
        promptMeta = options?.promptMeta;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'meta' }
const a = await agent('p', {
  label: 'a',
  meta: { credsRef: 'vault://qa', allowedDomains: ['preview.example.com'] },
  promptMeta: { viewport: '1280x800' },
})
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    // Cross-realm objects have a different Object.prototype; normalize through JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(meta)), {
      credsRef: "vault://qa",
      allowedDomains: ["preview.example.com"],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(promptMeta)), { viewport: "1280x800" });
  });

  it("passes undefined through when neither is provided", async () => {
    let sawOptions = false;
    let meta: unknown = "sentinel";
    let promptMeta: unknown = "sentinel";
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        sawOptions = true;
        meta = options?.meta;
        promptMeta = options?.promptMeta;
        return "ok" as AgentResult<S>;
      },
    };
    await runWorkflow(
      `export const meta = { name: 'm', description: 'meta' }
return await agent('p', { label: 'a' })`,
      { agent: capturing, persistLogs: false },
    );
    assert.ok(sawOptions);
    assert.equal(meta, undefined);
    assert.equal(promptMeta, undefined);
  });

  it("does NOT fold meta/promptMeta into the resume identity hash", async () => {
    const echo: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        return `ran:${prompt}` as AgentResult<S>;
      },
    };
    const journalOf = async (withMeta: boolean): Promise<JournalEntry[]> => {
      const journal: JournalEntry[] = [];
      const opts = withMeta
        ? `{ label: 'a', meta: { credsRef: 'vault://qa' }, promptMeta: { viewport: '1280x800' } }`
        : `{ label: 'a' }`;
      const script = `export const meta = { name: 'm2', description: 'meta' }
return await agent('same', ${opts})`;
      await runWorkflow(script, {
        agent: echo,
        persistLogs: false,
        onAgentJournal: (e) => journal.push(e),
      });
      return journal;
    };

    const [withMeta] = await journalOf(true);
    const [withoutMeta] = await journalOf(false);
    assert.equal(
      withMeta.hash,
      withoutMeta.hash,
      "adding meta/promptMeta must keep the resume key byte-identical (not part of the identity)",
    );
  });
});
