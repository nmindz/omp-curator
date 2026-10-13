import { SKILL_MD_RE, archivedSkillFromPath, backfillSpawns, emitMentions, entryTime, listJsonl, scanJsonlFiles, skillFromUrl } from "../jsonl.ts";
import type { JsonlParser } from "../jsonl.ts";
import type { UsageSource } from "../types.ts";

/** OMP persists `/skill:` invocations and subagent autoloads as `skill-prompt` custom messages. */
const SKILL_PROMPT = "skill-prompt";
/** omp-curator's own invocation message for dormant skills (`/skill:` or `/curator load`). */
export const CURATOR_SKILL = "omp-curator-skill";

export const ompParser: JsonlParser = {
	needles: ["skill://", `"${SKILL_PROMPT}"`, `"${CURATOR_SKILL}"`, "SKILL.md", "/skills/", '"task"'],
	parse(entry, { known, archiveDir, spawn }, emit) {
		const at = entryTime(entry);
		if (!at) return;
		if (entry.type === "custom_message" && (entry.customType === SKILL_PROMPT || entry.customType === CURATOR_SKILL)) {
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
					// A dormant skill lazy-loaded through the extension's `skill://` redirect.
					const dormant = archivedSkillFromPath(args.path, archiveDir);
					const name = dormant ?? SKILL_MD_RE.exec(args.path)?.[1];
					if (name) emit(name, dormant ? "read" : "file", at);
				}
			} else if (block.name === "bash" && typeof args.command === "string") {
				emitMentions(args.command, known, at, emit);
			} else if (block.name === "task" && Array.isArray(args.tasks)) {
				// Each task names the agent definition it runs; omitted means the built-in `task`.
				for (const task of args.tasks as Array<{ agent?: unknown }>) spawn(typeof task?.agent === "string" ? task.agent : "task", at);
			}
		}
	},
};

export const ompSource: UsageSource = {
	id: "omp",
	description: "OMP sessions, including subagent transcripts (~/.omp/agent/sessions)",
	locations: paths => [paths.sessionsDir],
	// OMP is the host harness: unreadable OMP history is a real failure, not an uninstall.
	required: true,
	async scan(ctx) {
		return scanJsonlFiles(ctx, "omp", await listJsonl(ctx.paths.sessionsDir), ompParser);
	},
	async backfillSpawns(ctx) {
		await backfillSpawns(ctx, "omp", await listJsonl(ctx.paths.sessionsDir), ompParser);
	},
};
