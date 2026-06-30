// The client-side structured-output GUARD: validate-then-re-prompt.
//
// Ported from pi src/agent.ts (findJsonBlock + extractValidated, KEPT VERBATIM; the
// `defineTool`/`structured_output` capture path is DROPPED because ACP backends constrain
// natively). resolveStructuredOutput is re-cut for ACP: the native constraint replaces the
// injected tool, so the ladder is
//   1. native constraint  (Claude: structured_output off the raw _claude/sdkMessage;
//                           Codex: the JSON-parsed final assistant message)
//   2. client-side validate against the schema (typebox Convert -> Check)
//   3. on miss, re-prompt up to maxSchemaRetries (then strict prose extraction each turn)
//   4. exhausted -> SCHEMA_NONCOMPLIANCE (non-recoverable; surfaced, never a silent null).
// A re-prompt turn that itself hits a provider wall REJECTS (the ACP request throws); the
// runner's catch classifies that as PROVIDER_USAGE_LIMIT, so we never need to gate on the
// assistant's own task text here.
import type { TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { WorkflowError, WorkflowErrorCode } from "@agentprism/shared-types";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present, else the
 * first balanced {...} or [...]. Best-effort (the schema check is the real gate). Returns the
 * raw JSON string, or undefined when none is found. (Ported VERBATIM from pi agent.ts.)
 */
export function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Coerce an already-parsed value toward the schema and accept it only if it then validates. */
export function validateValue(value: unknown, schema: TSchema): unknown {
  try {
    const converted = Convert(schema, value);
    if (Check(schema, converted)) return converted;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce it toward
 * the schema, and accept it only if it then validates. Never fabricates — returns undefined
 * unless the parsed value genuinely satisfies the schema. (Ported VERBATIM from pi agent.ts.)
 */
export function extractValidated(text: string, schema: TSchema): unknown {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return validateValue(parsed, schema);
}

/** Minimal session surface the structured-output ladder needs (real ACP session or a test double). */
export interface StructuredSession {
  /** Send one more (re-prompt) turn and drain it. */
  prompt(text: string): Promise<void>;
  /** The latest turn's assistant text (for prose extraction). */
  lastText(): string;
  /** The backend's native structured result for the latest turn (unvalidated), or undefined. */
  tryNative(): unknown;
}

export interface ResolveOptions {
  /** Extra repair turns before giving up. Leaf default 2 (matches pi). */
  maxSchemaRetries?: number;
  signal?: AbortSignal;
  label?: string;
}

const REPROMPT_TEXT = [
  "Your previous reply did not return valid JSON matching the required output schema.",
  "Reply now with ONLY a single JSON object that conforms to the schema —",
  "no prose, no explanation, and no markdown code fences.",
].join(" ");

/**
 * Resolve a schema agent's result via the ladder above. Returns the validated value (typed
 * unknown at this layer; the caller casts to the seam's AgentResult<S>). Throws
 * SCHEMA_NONCOMPLIANCE (non-recoverable) when no valid value is produced after the retries.
 */
export async function resolveStructuredOutput(
  session: StructuredSession,
  schema: TSchema,
  options: ResolveOptions,
): Promise<unknown> {
  const tryResolve = (): unknown => {
    const native = session.tryNative();
    if (native !== undefined && native !== null) {
      const validated = validateValue(native, schema);
      if (validated !== undefined) return validated;
    }
    return extractValidated(session.lastText(), schema);
  };

  let resolved = tryResolve();
  if (resolved !== undefined) return resolved;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    options.signal?.throwIfAborted();
    await session.prompt(REPROMPT_TEXT);
    resolved = tryResolve();
    if (resolved !== undefined) return resolved;
  }

  throw new WorkflowError(
    "Subagent did not produce valid structured output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}
