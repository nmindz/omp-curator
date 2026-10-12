import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { SKILL_MD_RE } from "../jsonl.ts";
import type { UsageSource } from "../types.ts";

interface PartRow {
	id: string;
	created: number;
	updated: number;
	session: string;
	tool: string | null;
	input: string | null;
}

/**
 * WAL size only: opening the database read-only can create or touch an empty `-wal`, but
 * only a commit grows it, and a checkpoint changes the main file instead.
 */
async function walSize(path: string): Promise<string> {
	return String((await stat(path).catch(() => undefined))?.size ?? 0);
}

/**
 * OpenCode upserts tool parts: a call is first stored pending with empty input and later
 * updated in place, keeping `time_created`. The cursor therefore follows `time_updated`
 * (inclusive, so rows committed in the same millisecond are not lost) and events are
 * de-duplicated by part id.
 */
export const opencodeSource: UsageSource = {
	id: "opencode",
	description: "OpenCode tool parts (opencode.db: `skill` tool calls and SKILL.md reads)",
	async scan(ctx) {
		const path = ctx.paths.opencodeDb;
		const info = await stat(path).catch(() => undefined);
		if (!info) return { added: 0, files: 0 };
		const key = `opencode:${path}`;
		// Committed rows can sit in the WAL without touching the main file.
		const wal = await walSize(`${path}-wal`);
		const cursor = ctx.db.cursors[key];
		if (cursor && cursor.size === info.size && cursor.mtimeMs === info.mtimeMs && cursor.wal === wal) return { added: 0, files: 0 };
		let since = cursor?.offset ?? 0;
		if (cursor && info.size < cursor.size) {
			ctx.db.events = ctx.db.events.filter(event => !event.src.startsWith(`${key}#`));
			since = 0;
		}
		const seen = new Set(ctx.db.events.filter(event => event.harness === "opencode" && event.id).map(event => event.id));
		const sqlite = new Database(path, { readonly: true });
		let added = 0;
		let maxUpdated = since;
		try {
			const rows = sqlite
				.query(
					`select id, time_created as created, time_updated as updated, session_id as session,
					        json_extract(data, '$.tool') as tool, json_extract(data, '$.state.input') as input
					 from part
					 where time_updated >= ?1
					   and (data like '%"tool":"skill"%' or (data like '%"tool":"read"%' and data like '%SKILL.md%'))`,
				)
				.all(since) as PartRow[];
			for (const row of rows) {
				maxUpdated = Math.max(maxUpdated, row.updated);
				if (seen.has(row.id) || !row.input || (row.tool !== "skill" && row.tool !== "read")) continue;
				const input = JSON.parse(row.input) as { name?: unknown; filePath?: unknown };
				let name: string | undefined;
				if (row.tool === "skill" && typeof input.name === "string") name = input.name;
				if (row.tool === "read" && typeof input.filePath === "string") name = SKILL_MD_RE.exec(input.filePath)?.[1];
				// Still pending: picked up when the row is updated with its input.
				if (!name) continue;
				seen.add(row.id);
				ctx.db.events.push({
					skill: name,
					kind: row.tool === "skill" ? "skill-tool" : "file",
					at: new Date(row.created).toISOString(),
					harness: "opencode",
					src: `${key}#${row.session}`,
					id: row.id,
				});
				added++;
			}
		} finally {
			sqlite.close();
		}
		ctx.db.cursors[key] = { size: info.size, mtimeMs: info.mtimeMs, offset: maxUpdated, wal };
		return { added, files: 1 };
	},
};
