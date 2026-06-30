/**
 * Minimal, dependency-free Markdown frontmatter parser.
 *
 * Replaces Pi's `parseFrontmatter` (from @earendil-works/pi-coding-agent) so the
 * engine carries no Pi dependency. It supports exactly the YAML subset an agent
 * definition file uses: a leading `---` … `---` block of `key: value` scalars,
 * flow sequences (`key: [a, b]`), and block sequences (`key:` then `  - item`
 * lines). Values are returned as strings (or string arrays); the caller
 * (parseAgentDefinition) reads only string / string[] fields and is defensive
 * about anything else, so richer YAML typing is unnecessary here.
 *
 * When the content has no leading frontmatter block, the whole content is the body
 * and the frontmatter is `{}` — matching how the Pi parser behaved for the agent
 * registry's "treat the whole file as a body" fallback.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  // A frontmatter block is a leading `---` line, the YAML body, then a closing
  // `---` line. Tolerate an optional BOM and CRLF line endings.
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const yaml = match[1];
  const body = match[2] ?? "";
  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2].trim();

    if (rawValue === "") {
      // A key with no inline value may introduce a block sequence (`  - item`).
      const items: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const seqLine = lines[j];
        const seq = /^[ \t]*-[ \t]+(.*)$/.exec(seqLine);
        if (seq) {
          items.push(parseScalar(seq[1].trim()));
          continue;
        }
        // Blank/comment lines inside a sequence are skipped; anything else ends it.
        const seqTrimmed = seqLine.trim();
        if (!seqTrimmed || seqTrimmed.startsWith("#")) continue;
        break;
      }
      if (items.length) {
        out[key] = items;
        i = j - 1;
      } else {
        out[key] = "";
      }
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      out[key] = inner === "" ? [] : inner.split(",").map((s) => parseScalar(s.trim()));
    } else {
      out[key] = parseScalar(rawValue);
    }
  }
  return out;
}

function parseScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
