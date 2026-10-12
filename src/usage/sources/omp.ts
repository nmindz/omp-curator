import { SKILL_MD_RE, emitMentions, entryTime, listJsonl, scanJsonlFiles, skillFromUrl } from "../jsonl.ts";
import type { JsonlParser } from "../jsonl.ts";
import type { UsageSource } from "../types.ts";

/** OMP persists `/skill:` invocations and subagent autoloads as `skill-prompt` custom messages. */
const SKILL_PROMPT = "skill-prompt";

export const ompParser: JsonlParser = {
	needles: ["skill://", `"${SKILL_PROMPT}"`, "SKILL.md", "/skills/"],
	parse(entry, known, emit) {
		const at = entryTime(entry);
		if (!at) return;
		if (entry.type === "custom_message" && entry.customType === SKILL_PROMPT) {
			const name = (entry.details as { name?: unknown } | undefined)?.name;
			// Autoloads are injected hidden (`display: false`); `/skill:` invocations are displayed.
			if (typeof name === "string") emit(name, entry.display === false ? "autoload" : "command", at);
			return;
		}
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (entry.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block.type !== "toolCall") continue;
			const args = (block.arguments ?? {}) as Record<string, unknown>;
			if (block.name === "read" && typeof args.path === "string") {
				if (args.path.startsWith("skill://")) {
					const name = skillFromUrl(args.path, known);
					if (name) emit(name, "read", at);
				} else {
					const name = SKILL_MD_RE.exec(args.path)?.[1];
					if (name) emit(name, "file", at);
				}
			} else if (block.name === "bash" && typeof args.command === "string") {
				emitMentions(args.command, known, at, emit);
			}
		}
	},
};

export const ompSource: UsageSource = {
	id: "omp",
	description: "OMP sessions, including subagent transcripts (~/.omp/agent/sessions)",
	async scan(ctx) {
		return scanJsonlFiles(ctx, "omp", await listJsonl(ctx.paths.sessionsDir), ompParser);
	},
};
