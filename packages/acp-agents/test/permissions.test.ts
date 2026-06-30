// Area (5): toolNames/disallowedToolNames -> request_permission auto-responses.
// The headless runner decides allow/deny at the ACP permission boundary, matching
// best-effort against the request's title, kind, and any vendor _meta.*.toolName.
import test from "node:test";
import assert from "node:assert/strict";
import type { PermissionOption, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { decidePermission, type ToolPolicy } from "../src/index.js";

const ALLOW_ONCE: PermissionOption = { optionId: "allow-1", name: "Allow", kind: "allow_once" };
const ALLOW_ALWAYS: PermissionOption = { optionId: "allow-2", name: "Always", kind: "allow_always" };
const REJECT_ONCE: PermissionOption = { optionId: "reject-1", name: "Reject", kind: "reject_once" };
const REJECT_ALWAYS: PermissionOption = { optionId: "reject-2", name: "Always reject", kind: "reject_always" };

function req(
  toolCall: { title?: string; kind?: ToolKind; meta?: Record<string, unknown> },
  options: PermissionOption[] = [ALLOW_ONCE, REJECT_ONCE],
): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: {
      toolCallId: "tc-1",
      ...(toolCall.title ? { title: toolCall.title } : {}),
      ...(toolCall.kind ? { kind: toolCall.kind } : {}),
      ...(toolCall.meta ? { _meta: toolCall.meta } : {}),
    },
    options,
  };
}

function selectedId(r: ReturnType<typeof decidePermission>): string | undefined {
  return r.outcome.outcome === "selected" ? r.outcome.optionId : undefined;
}

test("default (no policy) ALLOWS — a headless subagent can do real work", () => {
  assert.equal(selectedId(decidePermission(req({ title: "Read file", kind: "read" }), {})), "allow-1");
});

test("deny-list match REJECTS (matched against title/kind/meta toolName)", () => {
  const policy: ToolPolicy = { deny: ["bash"] };
  // match by title substring
  assert.equal(selectedId(decidePermission(req({ title: "Run Bash command" }), policy)), "reject-1");
  // match by vendor _meta toolName (Claude stamps it nested)
  assert.equal(
    selectedId(decidePermission(req({ title: "Execute", meta: { claude: { toolName: "Bash" } } }), policy)),
    "reject-1",
  );
  // unrelated tool is allowed
  assert.equal(selectedId(decidePermission(req({ title: "Read file" }), policy)), "allow-1");
});

test("non-empty allow-list: a tool matching NOTHING is denied; a match is allowed", () => {
  const policy: ToolPolicy = { allow: ["read", "grep"] };
  assert.equal(selectedId(decidePermission(req({ title: "Read file" }), policy)), "allow-1");
  assert.equal(selectedId(decidePermission(req({ title: "Write file" }), policy)), "reject-1");
});

test("deny is applied AFTER allow: a tool on both lists is denied", () => {
  const policy: ToolPolicy = { allow: ["bash", "read"], deny: ["bash"] };
  assert.equal(selectedId(decidePermission(req({ title: "bash" }), policy)), "reject-1");
  assert.equal(selectedId(decidePermission(req({ title: "read" }), policy)), "allow-1");
});

test("kind participates in matching when there is no title", () => {
  assert.equal(selectedId(decidePermission(req({ kind: "execute" }), { deny: ["execute"] })), "reject-1");
});

test("option-kind preference order: allow_always/reject_always when *_once is absent", () => {
  // want-allow, only allow_always offered
  assert.equal(selectedId(decidePermission(req({ title: "x" }, [ALLOW_ALWAYS, REJECT_ONCE]), {})), "allow-2");
  // want-reject, only reject_always offered
  assert.equal(
    selectedId(decidePermission(req({ title: "bash" }, [ALLOW_ONCE, REJECT_ALWAYS]), { deny: ["bash"] })),
    "reject-2",
  );
});

test("no option of the desired polarity exists => cancelled (the only way to refuse)", () => {
  // want to reject, but the server offers ONLY allow options => cancel the permission
  const r = decidePermission(req({ title: "bash" }, [ALLOW_ONCE, ALLOW_ALWAYS]), { deny: ["bash"] });
  assert.deepEqual(r.outcome, { outcome: "cancelled" });
});

test("empty allow/deny arrays behave as 'no policy' (allow)", () => {
  assert.equal(selectedId(decidePermission(req({ title: "anything" }), { allow: [], deny: [] })), "allow-1");
});

test("matching is case-insensitive and bidirectional substring", () => {
  // pattern longer than the candidate name still matches (p.includes(n))
  assert.equal(selectedId(decidePermission(req({ title: "rm" }), { deny: ["rm -rf"] })), "reject-1");
  // candidate longer than the pattern matches (n.includes(p))
  assert.equal(selectedId(decidePermission(req({ title: "ReadFileTool" }), { allow: ["read"] })), "allow-1");
});
