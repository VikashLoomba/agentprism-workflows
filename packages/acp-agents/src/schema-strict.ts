// typebox/JSON-Schema -> the two on-the-wire shapes the backends need.
//
// CRITICAL (resume identity): the engine JSON.stringify's the EXACT typebox schema object
// into hashAgentCall (workflow.ts:1062), so the schema that feeds the resume hash MUST NOT
// be mutated. Both helpers below DEEP-CLONE via a JSON round-trip (which also strips
// typebox's internal Symbol-keyed metadata, leaving a clean JSON Schema) and only ever
// touch the copy. The original opts.schema reference is never written to.
import type { TSchema } from "typebox";

/** Deep-clone a typebox schema into a plain JSON Schema object (Claude `outputFormat.schema`). */
export function toJsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

// JSON-Schema keywords OpenAI strict structured output does NOT accept. Stripped on the
// COPY before sending to Codex (turn/start.outputSchema is sent in strict mode). Structural
// keywords (type/properties/items/enum/anyOf/oneOf/allOf/$ref/$defs/definitions/const/
// description/required/additionalProperties) are preserved.
const STRICT_UNSUPPORTED_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "title",
  "default",
  "examples",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "patternProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

function normalizeStrictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeStrictNode);
  if (node === null || typeof node !== "object") return node;

  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (STRICT_UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = normalizeStrictNode(value);
  }

  // OpenAI strict rule: every object must set additionalProperties:false and list EVERY
  // property in `required`. Treat a node as an object schema when it declares properties
  // (type may be "object" or omitted by some generators).
  const properties = out["properties"];
  const isObjectSchema =
    out["type"] === "object" || (out["type"] === undefined && properties !== undefined);
  if (isObjectSchema && properties !== null && typeof properties === "object") {
    out["additionalProperties"] = false;
    out["required"] = Object.keys(properties as Record<string, unknown>);
  }
  return out;
}

/**
 * Deep-clone a typebox schema and normalize it to OpenAI STRICT rules (Codex
 * `turn/start.outputSchema`): every property required, additionalProperties:false,
 * unsupported validation keywords stripped. Operates on the clone only — the schema that
 * feeds hashAgentCall is never mutated.
 */
export function toStrictJsonSchema(schema: TSchema): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as unknown;
  return normalizeStrictNode(clone) as Record<string, unknown>;
}
