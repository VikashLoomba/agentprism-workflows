// toolNames / disallowedToolNames -> ACP session/request_permission auto-responses.
//
// ACP lets a client auto-respond to permission requests without user interaction
// (§5.5). The runner is headless, so we DECIDE allow/deny at that boundary from the
// agentType's allow-list (toolNames) and deny-list (disallowedToolNames). The ACP
// permission request does not carry a first-class tool NAME, so we match best-effort
// against the request's title, kind, and any vendor `_meta.*.toolName` (Claude stamps it).
// Default is ALLOW so a headless subagent can do real work; a matched deny-rule, or a
// non-empty allow-list with no match, rejects.
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface ToolPolicy {
  /** Allow-list (agentType `tools`). When non-empty, a tool that matches NOTHING is denied. */
  allow?: string[];
  /** Deny-list (agentType `disallowedTools`), applied after the allow-list. */
  deny?: string[];
}

const ALLOW_KIND_ORDER: PermissionOptionKind[] = ["allow_once", "allow_always"];
const REJECT_KIND_ORDER: PermissionOptionKind[] = ["reject_once", "reject_always"];

/** Decide the auto-response for one permission request given the tool policy. */
export function decidePermission(
  request: RequestPermissionRequest,
  policy: ToolPolicy,
): RequestPermissionResponse {
  const names = candidateToolNames(request);
  const denied = !!policy.deny && policy.deny.length > 0 && namesMatchAny(names, policy.deny);
  const hasAllowList = !!policy.allow && policy.allow.length > 0;
  const allowedByList = !hasAllowList || namesMatchAny(names, policy.allow as string[]);
  const wantAllow = !denied && allowedByList;

  const option = pickOption(request.options, wantAllow);
  if (!option) {
    // No option of the desired polarity exists. Cancelling the permission is the only
    // remaining way to refuse a tool the server offers no reject option for.
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function candidateToolNames(request: RequestPermissionRequest): string[] {
  const out: string[] = [];
  const toolCall = request.toolCall;
  if (toolCall.title) out.push(toolCall.title);
  if (toolCall.kind) out.push(toolCall.kind);
  collectMetaToolNames(toolCall._meta, out);
  return out;
}

function collectMetaToolNames(meta: unknown, out: string[]): void {
  if (!meta || typeof meta !== "object") return;
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (key === "toolName" && typeof value === "string") out.push(value);
    else if (value && typeof value === "object") collectMetaToolNames(value, out);
  }
}

function namesMatchAny(names: string[], patterns: string[]): boolean {
  const lowered = names.map((n) => n.toLowerCase()).filter(Boolean);
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (!p) return false;
    return lowered.some((n) => n === p || n.includes(p) || p.includes(n));
  });
}

function pickOption(options: PermissionOption[], wantAllow: boolean): PermissionOption | undefined {
  const order = wantAllow ? ALLOW_KIND_ORDER : REJECT_KIND_ORDER;
  for (const kind of order) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}
