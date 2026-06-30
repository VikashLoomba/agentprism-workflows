// A MOCK ACP agent server (no network, no real Claude/Codex). Spawned by the runner
// under test via the AGENTPRISM_*_ACP_CMD/ARGS spawn override:
//   AGENTPRISM_CLAUDE_ACP_CMD=<node>  AGENTPRISM_CLAUDE_ACP_ARGS=<this file>
// It speaks REAL ACP over its own stdio using the SDK's AgentSideConnection, so the
// runner's real ClientSideConnection, draining, permission, usage, and structured-output
// plumbing are all exercised end-to-end — only the backend agent is faked.
//
// Behavior is scripted per-test via env:
//   AGENTPRISM_FAKE_SCENARIO : JSON describing configOptions + a list of per-turn behaviors
//   AGENTPRISM_FAKE_LOG      : path to which every observed ACP request is appended as JSONL
//                              (so the parent test can assert exactly what the agent received)
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const scenario = JSON.parse(process.env.AGENTPRISM_FAKE_SCENARIO ?? "{}");
const logPath = process.env.AGENTPRISM_FAKE_LOG;

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // best-effort observation channel
  }
}

const defaultConfigOptions = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "default-model",
    options: [
      { value: "claude-opus-4-1", name: "Claude Opus 4.1" },
      { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { value: "gpt-5-codex[high]", name: "GPT-5 Codex (high)" },
      { value: "default-model", name: "Default" },
    ],
  },
];

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.configOptions = scenario.configOptions ?? defaultConfigOptions;
    this.turnIndex = 0;
    this.sessionId = "fake-session-1";
  }

  initialize(params) {
    record({ method: "initialize", params });
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  }

  newSession(params) {
    record({ method: "newSession", params });
    return { sessionId: this.sessionId, configOptions: this.configOptions };
  }

  setSessionConfigOption(params) {
    record({ method: "setSessionConfigOption", params });
    // Echo the catalog back with the requested value marked current.
    this.configOptions = this.configOptions.map((opt) =>
      opt.id === params.configId ? { ...opt, currentValue: params.value } : opt,
    );
    return { configOptions: this.configOptions };
  }

  async prompt(params) {
    record({ method: "prompt", params });
    const turns = scenario.turns ?? [{ text: "ok" }];
    const turn = turns[Math.min(this.turnIndex, turns.length - 1)] ?? {};
    this.turnIndex += 1;

    // 1) optional permission round-trip (agent -> client request)
    if (turn.toolCall) {
      const response = await this.conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "tc-1",
          title: turn.toolCall.title,
          kind: turn.toolCall.kind,
          ...(turn.toolCall.meta ? { _meta: turn.toolCall.meta } : {}),
        },
        options: turn.toolCall.options ?? [
          { optionId: "allow-1", name: "Allow", kind: "allow_once" },
          { optionId: "reject-1", name: "Reject", kind: "reject_once" },
        ],
      });
      record({ method: "permissionOutcome", outcome: response.outcome });
    }

    // 2) optional assistant text chunks (drained before the prompt response resolves)
    const texts = turn.text === undefined ? [] : Array.isArray(turn.text) ? turn.text : [turn.text];
    for (const text of texts) {
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }

    // 3) optional usage_update notification (carries the cumulative cost)
    if (turn.usageUpdate) {
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "usage_update", ...turn.usageUpdate },
      });
    }

    // 4) optional Claude raw structured_output via the _claude/sdkMessage ext notification
    if (turn.structuredOutput !== undefined) {
      await this.conn.extNotification("_claude/sdkMessage", {
        message: { type: "result", subtype: "success", structured_output: turn.structuredOutput },
      });
    }

    // 5) hard failure path: reject the prompt request (provider wall / process fault).
    // Real backends (claude-agent-acp failActive / codex-acp request errors) reject with the
    // failure text carried in the JSON-RPC error MESSAGE, which is what the SDK surfaces as
    // RequestError.message on the client. Mirror that exactly so errors-map classifies it.
    if (turn.throw !== undefined) {
      throw new RequestError(turn.throwCode ?? -32000, turn.throw);
    }

    return {
      stopReason: turn.stopReason ?? "end_turn",
      ...(turn.usage ? { usage: turn.usage } : {}),
    };
  }

  cancel(params) {
    record({ method: "cancel", params });
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
