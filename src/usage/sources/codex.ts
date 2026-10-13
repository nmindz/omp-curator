import { SKILL_MD_RE, emitMentions, entryTime, listJsonl, scanJsonlFiles } from "../jsonl.ts";
import type { Emit, JsonlParser } from "../jsonl.ts";
import type { UsageSource } from "../types.ts";

/** Codex injects an explicitly invoked skill (`$name` in the prompt) as a `<skill>` user message. */
const INJECTED_RE = /^<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]*)<\/path>/;
const SKILL_MD_ALL_RE = /\/skills\/([^/\s'"`]+)\/SKILL\.md\b/g;
/** Commands that print a file; Codex opens a skill it picks by itself this way. */
const READER_RE = /^\s*(?:cat|sed|head|tail|nl|bat|less|more|awk)\b/;

function shellCommand(args: Record<string, unknown>): string | undefined {
	// `exec_command` (current), `shell_command`, and legacy `shell` with an argv array.
	const raw = args.cmd ?? args.command;
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw)) return undefined;
	const argv = raw.filter((part): part is string => typeof part === "string");
	// `["bash", "-lc", "<script>"]`: the script is the command.
	return /(?:^|\/)(?:ba|z)?sh$/.test(argv[0] ?? "") && /^-\w*c$/.test(argv[1] ?? "") ? argv.slice(2).join(" ") : argv.join(" ");
}

function emitCommand(command: string, known: Set<string>, at: string, emit: Emit): void {
	if (!READER_RE.test(command)) {
		emitMentions(command, known, at, emit);
		return;
	}
	const names = new Set(Array.from(command.matchAll(SKILL_MD_ALL_RE), match => match[1]!));
	if (names.size === 0) emitMentions(command, known, at, emit);
	for (const name of names) emit(name, "file", at);
}

export const codexParser: JsonlParser = {
	needles: ["<skill>", "SKILL.md", "/skills/"],
	parse(entry, { known }, emit) {
		const at = entryTime(entry);
		const payload = entry.payload as Record<string, unknown> | undefined;
		if (!at || entry.type !== "response_item" || !payload) return;
		if (payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
			for (const part of payload.content as Array<{ text?: unknown }>) {
				if (typeof part.text !== "string") continue;
				const match = INJECTED_RE.exec(part.text);
				if (!match) continue;
				const name = known.has(match[1]!) ? match[1]! : SKILL_MD_RE.exec(match[2]!)?.[1];
				if (name) emit(name, "command", at);
			}
			return;
		}
		if (payload.type === "function_call" && typeof payload.arguments === "string") {
			const args = JSON.parse(payload.arguments) as Record<string, unknown>;
			const command = shellCommand(args);
			if (command) emitCommand(command, known, at, emit);
		}
	},
};

export const codexSource: UsageSource = {
	id: "codex",
	description: "Codex rollouts (~/.codex/sessions and archived_sessions)",
	locations: paths => paths.codexSessionsDirs,
	async scan(ctx) {
		const files = (await Promise.all(ctx.paths.codexSessionsDirs.map(listJsonl))).flat();
		return scanJsonlFiles(ctx, "codex", files, codexParser);
	},
};
