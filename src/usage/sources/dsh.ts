import { SKILL_MD_RE, emitMentions, listFiles, scanZstdJsonlFiles } from "../jsonl.ts";
import type { JsonlParser } from "../jsonl.ts";
import type { UsageSource } from "../types.ts";

interface DshData {
	name?: unknown;
	arguments?: unknown;
	source?: { kind?: unknown; name?: unknown };
}

export const dshParser: JsonlParser = {
	needles: ['"skill"', "skill-invocation", "SKILL.md", "/skills/"],
	parse(entry, { known }, emit) {
		if (typeof entry.time !== "number") return;
		const at = new Date(entry.time).toISOString();
		const data = (entry.data ?? {}) as DshData;
		if (entry.type === "user/message") {
			// `/skill-name` typed by the user.
			if (data.source?.kind === "skill-invocation" && typeof data.source.name === "string") emit(data.source.name, "command", at);
			return;
		}
		if (entry.type !== "tool/call" || typeof data.arguments !== "string") return;
		const args = JSON.parse(data.arguments) as Record<string, unknown>;
		if (data.name === "skill" && typeof args.name === "string") {
			emit(args.name, "skill-tool", at);
		} else if (data.name === "read" && typeof args.file_path === "string") {
			const name = SKILL_MD_RE.exec(args.file_path)?.[1];
			if (name) emit(name, "file", at);
		} else if (data.name === "bash" && typeof args.command === "string") {
			emitMentions(args.command, known, at, emit);
		}
	},
};

export const dshSource: UsageSource = {
	id: "dsh",
	description: "DeepSeek Harness sessions (~/.dsh/sessions, zstd-compressed)",
	locations: paths => [paths.dshSessionsDir],
	async scan(ctx) {
		return scanZstdJsonlFiles(ctx, "dsh", await listFiles(ctx.paths.dshSessionsDir, ".jsonl.zstd"), dshParser);
	},
};
