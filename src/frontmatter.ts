export type FrontmatterValue = string | boolean | string[];

/**
 * Parse the top-level scalar and list keys of a SKILL.md / agent frontmatter block.
 * Supports plain, single- and double-quoted scalars, folded (`>`) and literal (`|`)
 * block scalars, inline `[a, b]` lists and `- item` block lists. Nested maps are skipped.
 */
export function parseFrontmatter(text: string): Record<string, FrontmatterValue> | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
	if (!match) return undefined;
	const lines = match[1]!.split(/\r?\n/);
	const out: Record<string, FrontmatterValue> = {};
	for (let i = 0; i < lines.length; i++) {
		const keyMatch = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]!);
		if (!keyMatch) continue;
		const key = keyMatch[1]!;
		const raw = (keyMatch[2] ?? "").trim();

		if (/^[>|][+-]?$/.test(raw)) {
			const block: string[] = [];
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
				block.push(lines[++i]!.trim());
			}
			out[key] = raw.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
			continue;
		}
		if (raw === "") {
			const items: string[] = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) {
				items.push(unquote(lines[++i]!.replace(/^\s*-\s+/, "").trim()));
			}
			if (items.length > 0) out[key] = items;
			continue;
		}
		if (raw.startsWith("[") && raw.endsWith("]")) {
			out[key] = raw
				.slice(1, -1)
				.split(",")
				.map(item => unquote(item.trim()))
				.filter(Boolean);
			continue;
		}
		if (raw === "true" || raw === "false") {
			out[key] = raw === "true";
			continue;
		}
		out[key] = unquote(raw);
	}
	return out;
}

/**
 * Plain (unquoted) top-level values that lenient parsers accept but strict YAML rejects or
 * truncates. The `skills` CLI uses a strict parser and skips such skills entirely.
 */
export function strictYamlIssues(text: string): string[] {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return [];
	const issues: string[] = [];
	for (const line of match[1]!.split(/\r?\n/)) {
		const keyMatch = /^([A-Za-z_][\w-]*):\s+(.+)$/.exec(line);
		if (!keyMatch) continue;
		const [, key, value] = keyMatch as unknown as [string, string, string];
		if (/^["'>|[{]/.test(value)) continue;
		if (value.includes(": ")) issues.push(`unquoted "${key}" contains ": " (strict YAML parsers such as \`skills\` reject it; quote the value)`);
		else if (value.includes(" #")) issues.push(`unquoted "${key}" contains " #" (strict YAML truncates it as a comment; quote the value)`);
		else if (/^[@`%&*!]/.test(value)) issues.push(`unquoted "${key}" starts with a YAML indicator; quote the value`);
	}
	return issues;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replaceAll("''", "'");
	}
	return value.replace(/\s+#.*$/, "");
}
