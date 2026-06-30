// Area (1): typebox/JSON-Schema -> the two on-the-wire shapes, asserting the ORIGINAL
// (hash-feeding) schema object is NEVER mutated.
//
// The engine JSON.stringify's the EXACT typebox schema into the resume-identity hash
// (hashAgentCall), so both helpers must operate on a COPY only. We assert that with two
// independent checks per call: (a) JSON.stringify(schema) is byte-identical before/after
// (the hash input is stable), and (b) the specific fields a careless in-place normalizer
// would have clobbered are still present on the original.
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { toJsonSchema, toStrictJsonSchema } from "../src/index.js";

/** A structural view of a JSON-Schema node for reading runtime fields off either a plain
 *  output object or a typebox schema (which carries the same fields, just not in its static
 *  type). Going through `unknown` is the type-safe way to view these JSON values. */
interface JsonNode {
  type?: string;
  additionalProperties?: unknown;
  title?: unknown;
  required?: string[];
  properties?: Record<string, JsonNode>;
  items?: unknown;
  minLength?: number;
  format?: string;
  [k: string]: unknown;
}

const view = (value: unknown): JsonNode => value as JsonNode;

/** A schema that deliberately exercises every strict transformation:
 *  - top-level `additionalProperties: true` + `title` (an unsupported keyword)
 *  - a REQUIRED prop carrying unsupported validation keywords (minLength, format)
 *  - an OPTIONAL prop (NOT in typebox `required`) carrying `minimum`
 *  - a NESTED object that must itself get additionalProperties:false + full `required`
 *  - an array carrying `minItems` (unsupported) */
function buildSchema() {
  return Type.Object(
    {
      name: Type.String({ minLength: 1, format: "email", pattern: "^.+@.+$" }),
      age: Type.Optional(Type.Integer({ minimum: 0, maximum: 130 })),
      address: Type.Object({
        city: Type.String(),
        zip: Type.Optional(Type.String({ pattern: "\\d{5}" })),
      }),
      tags: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    },
    { additionalProperties: true, title: "Person", $id: "person.schema" },
  );
}

test("toStrictJsonSchema: every property required + additionalProperties:false (incl. nested)", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);

  assert.equal(strict.additionalProperties, false);
  // Optional `age` is FORCED into required by the strict normalizer.
  assert.deepEqual(strict.required, ["name", "age", "address", "tags"]);

  const props = strict.properties as Record<string, Record<string, unknown>>;
  // Nested object also normalized: additionalProperties:false + all of its props required.
  assert.equal(props.address.additionalProperties, false);
  assert.deepEqual(props.address.required, ["city", "zip"]);
});

test("toStrictJsonSchema: unsupported validation keywords are stripped on the copy", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, Record<string, unknown>>;
  const address = props.address.properties as Record<string, Record<string, unknown>>;

  // top-level non-structural keywords gone
  assert.equal("title" in strict, false);
  assert.equal("$id" in strict, false);
  // string validators gone, but structural `type` kept
  assert.equal(props.name.type, "string");
  assert.equal("minLength" in props.name, false);
  assert.equal("format" in props.name, false);
  assert.equal("pattern" in props.name, false);
  // numeric validators gone
  assert.equal("minimum" in props.age, false);
  assert.equal("maximum" in props.age, false);
  // array validators gone, items kept
  assert.equal("minItems" in props.tags, false);
  assert.equal("uniqueItems" in props.tags, false);
  assert.deepEqual(props.tags.items, { type: "string" });
  // nested string validator gone
  assert.equal("pattern" in address.zip, false);
});

test("toStrictJsonSchema: does NOT mutate the original hash-feeding schema", () => {
  const schema = buildSchema();
  const hashBefore = JSON.stringify(schema);

  toStrictJsonSchema(schema);

  // (a) the exact bytes the resume hash consumes are unchanged
  assert.equal(JSON.stringify(schema), hashBefore);
  // (b) the fields an in-place normalizer would have clobbered are intact
  const original = view(schema);
  assert.equal(original.additionalProperties, true);
  assert.equal(original.title, "Person");
  assert.deepEqual(original.required, ["name", "address", "tags"]); // optional `age` still absent
  assert.equal(original.properties?.name?.minLength, 1);
  assert.equal(original.properties?.name?.format, "email");
});

test("toJsonSchema (Claude path): plain clone that PRESERVES validation keywords, no strict rules", () => {
  const schema = buildSchema();
  const json = toJsonSchema(schema);
  const props = json.properties as Record<string, Record<string, unknown>>;

  // Claude consumes the SDK's own native constraint, so we do NOT impose OpenAI-strict rules:
  assert.equal(json.additionalProperties, true); // original value preserved, not forced false
  assert.deepEqual(json.required, ["name", "address", "tags"]); // optional `age` NOT added
  assert.equal(props.name.minLength, 1); // validation keywords preserved
  assert.equal(props.name.format, "email");
  assert.equal((json as Record<string, unknown>).title, "Person");
});

test("both helpers strip typebox's internal (~kind) metadata via the JSON round-trip", () => {
  const schema = buildSchema();
  // typebox carries a non-enumerable `~kind` marker on every node; JSON.stringify drops it.
  assert.ok(Object.getOwnPropertyNames(schema).includes("~kind"));

  for (const out of [toJsonSchema(schema), toStrictJsonSchema(schema)]) {
    assert.equal(Object.getOwnPropertyNames(out).includes("~kind"), false);
    const props = out.properties as Record<string, Record<string, unknown>>;
    assert.equal(Object.getOwnPropertyNames(props.name).includes("~kind"), false);
  }
  // ...and the original still has it (we cloned, not stripped-in-place).
  assert.ok(Object.getOwnPropertyNames(schema).includes("~kind"));
});

test("toStrictJsonSchema: returned copy is independent — mutating it cannot reach the original", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  (strict.properties as Record<string, unknown>).injected = { type: "string" };
  assert.equal("injected" in schema.properties, false);
});
