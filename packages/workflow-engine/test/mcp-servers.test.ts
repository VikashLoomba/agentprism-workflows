import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, AgentRunner, JournalEntry, McpServerConfig, RunOptions } from "@agentprism/shared-types";
import { runWorkflow } from "../src/workflow.js";

// (#5) agent({ mcpServers }) is an ADDITIVE run input: the engine must thread it through to
// the runner opts (so the runner can attach them at ACP session/new), but it must NOT enter
// the resume identity hash (hashAgentCall) — wiring tools changes which tools an agent can
// reach, not the logical call, and folding it into the hash would needlessly bust every
// cached result whenever tool wiring changes.

const STDIO_SERVER = { name: "fs", command: "mcp-fs", args: [], env: [] };

describe("agent({ mcpServers }) plumbing", () => {
  it("threads mcpServers from agent() into the runner opts", async () => {
    let captured: McpServerConfig[] | undefined;
    let invoked = false;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        invoked = true;
        captured = options?.mcpServers;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'mcp' }
const a = await agent('p', { label: 'a', mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }] })
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    assert.ok(invoked, "the runner was invoked");
    // The script builds the array inside the vm realm; normalize through JSON so deepStrictEqual
    // compares structure (cross-realm objects have a different Object.prototype) — the value the
    // runner would forward to session/new is exactly this.
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), [STDIO_SERVER]);
  });

  it("passes undefined mcpServers through when none is provided", async () => {
    let captured: McpServerConfig[] | undefined;
    let sawOptions = false;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        sawOptions = true;
        captured = options?.mcpServers;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'mcp' }
const a = await agent('p', { label: 'a' })
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    assert.ok(sawOptions);
    assert.equal(captured, undefined);
  });

  it("does NOT fold mcpServers into the resume identity hash", async () => {
    const echo: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        return `ran:${prompt}` as AgentResult<S>;
      },
    };
    const journalOf = async (withServers: boolean): Promise<JournalEntry[]> => {
      const journal: JournalEntry[] = [];
      const opts = withServers
        ? `{ label: 'a', mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }] }`
        : `{ label: 'a' }`;
      const script = `export const meta = { name: 'm2', description: 'mcp' }
const a = await agent('same', ${opts})
return a`;
      await runWorkflow(script, {
        agent: echo,
        persistLogs: false,
        onAgentJournal: (e) => journal.push(e),
      });
      return journal;
    };

    const [withServers] = await journalOf(true);
    const [withoutServers] = await journalOf(false);
    assert.equal(
      withServers.hash,
      withoutServers.hash,
      "adding mcpServers must keep the resume key byte-identical (it is not part of the identity)",
    );
  });
});
