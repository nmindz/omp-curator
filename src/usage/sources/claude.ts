import { SKILL_MD_RE, emitMentions, entryTime, listJsonl, scanJsonlFiles } from "../jsonl.ts";
import type { JsonlParser } from "../jsonl.ts";
import type { UsageSource } from "../types.ts";

export const claudeParser: JsonlParser = {
	needles: ['"Skill"', "SKILL.md", "/skills/", "<command-name>"],
	parse(entry, { known }, emit) {
		const at = entryTime(entry);
		const message = entry.message as { content?: unknown } | undefined;
		if (!at || !message) return;
		if (typeof message.content === "string") {
			const command = /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(message.content)?.[1];
			// Plugin skills are namespaced (`plugin:skill`); the store keys them by the bare name.
			const name = command?.split(":").pop();
			if (name && known.has(name)) emit(name, "command", at);
			return;
		}
		if (!Array.isArray(message.content)) return;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block.type !== "tool_use") continue;
			const input = (block.input ?? {}) as Record<string, unknown>;
			if (block.name === "Skill" && typeof input.skill === "string") {
				emit(input.skill.split(":").pop()!, "skill-tool", at);
			} else if (block.name === "Read" && typeof input.file_path === "string") {
				const name = SKILL_MD_RE.exec(input.file_path)?.[1];
				if (name) emit(name, "file", at);
			} else if (block.name === "Bash" && typeof input.command === "string") {
				emitMentions(input.command, known, at, emit);
			}
		}
	},
};

export const claudeSource: UsageSource = {
	id: "claude",
	description: "Claude Code transcripts (~/.claude/projects)",
	async scan(ctx) {
		return scanJsonlFiles(ctx, "claude", await listJsonl(ctx.paths.claudeProjectsDir), claudeParser);
	},
};
