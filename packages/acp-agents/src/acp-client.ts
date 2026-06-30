// The ACP client over stdio. Spawns a backend's ACP server (claude-agent-acp / patched
// codex-acp) as a child process, speaks ACP (JSON-RPC over newline-delimited stdio) to it via
// the SDK's ClientSideConnection, and exposes the lifecycle the runner needs:
//   initialize (benign clientInfo so Codex config options stay enabled)
//   -> session/new { cwd }
//   -> session/set_config_option (model selection)
//   -> session/prompt (+ drain session/update)
//   -> session/cancel (on opts.signal)
//
// Draining: ACP delivers a prompt turn as session/update notifications followed by the
// session/prompt response, in wire order on one stream. Our Client handlers are synchronous
// (they only push into arrays), so by the time `connection.prompt(...)` resolves, every
// update for that turn has already been folded into our accumulators.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { TSchema } from "typebox";
import type { AgentHistoryEntry } from "@agentprism/shared-types";
import type { Backend, StructuredSource } from "./backend.js";
import { decidePermission, type ToolPolicy } from "./permissions.js";
import { UsageAccumulator } from "./usage.js";

/** A benign client identity. NOT JetBrains/IntelliJ 2026.1 — that exact identity makes
 *  codex-acp disable session config options (our model/effort routing channel). */
const CLIENT_INFO = {
  name: "agentprism-workflows",
  title: "AgentPrism Workflows",
  version: "0.1.0",
} as const;

const CLAUDE_RAW_MESSAGE_METHOD = "_claude/sdkMessage";

interface RawResultSuccess {
  type: string;
  subtype: string;
  structured_output?: unknown;
}

/** The ACP Client handler: collects assistant text, tool history, usage, the Claude raw
 *  structured_output, and auto-answers permission requests from the tool policy. */
class WorkflowClient implements Client {
  readonly textChunks: string[] = [];
  readonly history: AgentHistoryEntry[] = [];
  rawResultSuccess: RawResultSuccess | undefined;
  private turnStartIndex = 0;

  constructor(
    private readonly policy: ToolPolicy,
    private readonly usage: UsageAccumulator,
  ) {}

  /** Mark the start of a new turn so currentTurnText()/structured_output read only this turn. */
  beginTurn(): void {
    this.turnStartIndex = this.textChunks.length;
    this.rawResultSuccess = undefined;
  }

  currentTurnText(): string {
    return this.textChunks.slice(this.turnStartIndex).join("");
  }

  requestPermission(params: RequestPermissionRequest): RequestPermissionResponse {
    return decidePermission(params, this.policy);
  }

  sessionUpdate(params: SessionNotification): void {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.textChunks.push(update.content.text);
          this.history.push({
            role: "assistant",
            kind: "text",
            text: update.content.text,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case "tool_call": {
        this.history.push({
          role: "tool",
          kind: "toolCall",
          text: update.title,
          toolName: toolNameFromMeta(update._meta) ?? update.kind,
          timestamp: Date.now(),
        });
        break;
      }
      case "usage_update": {
        this.usage.recordCost(update.cost);
        break;
      }
      default:
        break;
    }
  }

  extNotification(method: string, params: Record<string, unknown>): void {
    if (method !== CLAUDE_RAW_MESSAGE_METHOD) return;
    const message = (params as { message?: unknown }).message as RawResultSuccess | undefined;
    if (message && message.type === "result" && message.subtype === "success") {
      this.rawResultSuccess = message;
    }
  }
}

function toolNameFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  for (const value of Object.values(meta as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const toolName = (value as Record<string, unknown>).toolName;
      if (typeof toolName === "string") return toolName;
    }
  }
  return undefined;
}

export interface AcpSessionOptions {
  /** Absolute working directory for the ACP session (worktree isolation). */
  cwd: string;
  /** The schema for this run, if any (drives the backend's session/prompt `_meta`). */
  schema: TSchema | undefined;
  policy: ToolPolicy;
  signal?: AbortSignal;
}

type ModelSelectOption = Extract<SessionConfigOption, { type: "select" }>;

/** One ACP session against one backend subprocess. Single-session-per-run (one schema, one cwd). */
export class AcpAgentSession implements StructuredSource {
  readonly usage = new UsageAccumulator();

  private readonly backend: Backend;
  private readonly opts: AcpSessionOptions;
  private readonly child: ChildProcess;
  private readonly client: WorkflowClient;
  private readonly connection: ClientSideConnection;
  private sessionId = "";
  private configOptions: SessionConfigOption[] = [];
  private removeAbort: (() => void) | undefined;
  private stderrTail = "";

  private constructor(backend: Backend, opts: AcpSessionOptions, child: ChildProcess) {
    this.backend = backend;
    this.opts = opts;
    this.child = child;
    this.client = new WorkflowClient(opts.policy, this.usage);

    if (!child.stdin || !child.stdout) {
      throw new Error(`Failed to spawn ACP agent (${backend.id}): missing stdio pipes`);
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = new ClientSideConnection(() => this.client, stream);

    if (opts.signal) {
      const signal = opts.signal;
      const onAbort = () => {
        void this.cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.removeAbort = () => signal.removeEventListener("abort", onAbort);
    }
  }

  /** Spawn the backend, initialize, and open a session at `cwd`. */
  static async start(backend: Backend, opts: AcpSessionOptions): Promise<AcpAgentSession> {
    const { command, args, env } = backend.spawnConfig();
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: opts.cwd });
    const session = new AcpAgentSession(backend, opts, child);
    try {
      await session.bootstrap();
    } catch (error) {
      session.dispose();
      throw error;
    }
    return session;
  }

  private async bootstrap(): Promise<void> {
    // Race init against an early process failure so a missing/broken binary surfaces a clear
    // error instead of hanging on a JSON-RPC response that never comes.
    const failure = new Promise<never>((_, reject) => {
      this.child.once("error", (err: Error) => reject(err));
      this.child.once("exit", (code: number | null, sig: NodeJS.Signals | null) => {
        const tail = this.stderrTail.trim();
        reject(
          new Error(
            `ACP agent (${this.backend.id}) exited before initialization (code=${code}, signal=${sig})` +
              (tail ? `\n${tail}` : ""),
          ),
        );
      });
    });
    failure.catch(() => {
      // Prevent an unhandled rejection if init wins the race; the exit handler may still fire later.
    });

    await Promise.race([this.initialize(), failure]);
    await Promise.race([this.newSession(), failure]);
  }

  private async initialize(): Promise<void> {
    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { ...CLIENT_INFO },
    });
  }

  private async newSession(): Promise<void> {
    const meta = this.backend.sessionMeta(this.opts.schema);
    const request: NewSessionRequest = {
      cwd: this.opts.cwd,
      mcpServers: [],
      ...(meta ? { _meta: meta } : {}),
    };
    const response = await this.connection.newSession(request);
    this.sessionId = response.sessionId;
    this.configOptions = response.configOptions ?? [];
  }

  /**
   * Select the model for this session from the agent-advertised config options (§5.4).
   * Returns `matched:false` (the caller fires onModelFallback) when the catalog has no value
   * matching the spec, leaving the session default in place.
   */
  async selectModel(spec: string): Promise<{ matched: boolean; resolved?: string }> {
    const option = this.configOptions.find(isModelSelectOption);
    if (!option) return { matched: false };

    const values = flattenSelectOptions(option.options);
    const target = matchModelValue(values, spec);
    if (!target) return { matched: false };

    if (option.currentValue !== target.value) {
      const response = await this.connection.setSessionConfigOption({
        sessionId: this.sessionId,
        configId: option.id,
        value: target.value,
      });
      this.configOptions = response.configOptions;
    }
    return { matched: true, resolved: target.value };
  }

  /** Send a prompt turn and drain it; returns the final PromptResponse. */
  async prompt(text: string, promptMeta?: Record<string, unknown>): Promise<PromptResponse> {
    this.opts.signal?.throwIfAborted();
    this.client.beginTurn();
    const prompt: ContentBlock[] = [{ type: "text", text }];
    const request: PromptRequest = {
      sessionId: this.sessionId,
      prompt,
      ...(promptMeta ? { _meta: promptMeta } : {}),
    };
    const response = await this.connection.prompt(request);
    this.usage.recordPromptUsage(response.usage);
    return response;
  }

  /** StructuredSource — the latest turn's assistant text. */
  currentTurnText(): string {
    return this.client.currentTurnText();
  }

  /** StructuredSource — Claude's raw structured_output for the latest turn, if any. */
  rawStructuredOutput(): unknown {
    return this.client.rawResultSuccess?.structured_output;
  }

  /** Diagnostic message/tool history accumulated across the run. */
  get history(): AgentHistoryEntry[] {
    return this.client.history;
  }

  /** Best-effort ACP cancel (wired to opts.signal). The agent settles the turn as "cancelled". */
  async cancel(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch {
      // best-effort: the process is torn down in dispose() regardless.
    }
  }

  /** Tear down: drop the abort listener, end stdin, and kill the subprocess. */
  dispose(): void {
    this.removeAbort?.();
    this.removeAbort = undefined;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

function isModelSelectOption(option: SessionConfigOption): option is ModelSelectOption {
  return option.type === "select" && (option.category === "model" || option.id === "model");
}

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  const out: SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if ("options" in entry) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

/**
 * Best-effort match of a model spec (`provider/modelId`, a bare `modelId`, or a tier word)
 * against the agent's catalog. Tries, in priority order: exact spec, exact id-after-slash,
 * the Codex `model[effort]` encoding, exact option name, then substring fallbacks.
 */
function matchModelValue(
  values: SessionConfigSelectOption[],
  spec: string,
): SessionConfigSelectOption | undefined {
  const desired = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : spec;
  const fullLower = spec.toLowerCase();
  const idLower = desired.toLowerCase();
  const tests: Array<(value: SessionConfigSelectOption) => boolean> = [
    (value) => value.value.toLowerCase() === fullLower,
    (value) => value.value.toLowerCase() === idLower,
    (value) => value.value.toLowerCase().startsWith(`${idLower}[`),
    (value) => value.name.toLowerCase() === idLower,
    (value) => value.value.toLowerCase().includes(idLower),
    (value) => value.name.toLowerCase().includes(idLower),
  ];
  for (const test of tests) {
    const found = values.find(test);
    if (found) return found;
  }
  return undefined;
}
