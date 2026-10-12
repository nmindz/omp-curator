import { readJson, writeJsonAtomic } from "../fsutil.ts";
import type { Paths } from "../paths.ts";
import type { UsageDb, UsageEvent, UsageKind } from "./types.ts";

export interface SkillUsage {
	uses: number;
	lastUsed?: string;
	firstUsed?: string;
	byHarness: Record<string, number>;
	byKind: Partial<Record<UsageKind, number>>;
	/** Shell touches plus SKILL.md reads that were part of a bulk scan. */
	mentions: number;
	lastMention?: string;
}

/**
 * A session that reads SKILL.md files of this many distinct skills within the window is
 * inspecting or maintaining skills (audits, migrations), not using them.
 */
export const BULK_DISTINCT_SKILLS = 5;
export const BULK_WINDOW_MS = 30 * 60_000;

/** Bump when event classification changes; an older db is discarded and rebuilt from history. */
export const USAGE_DB_VERSION = 3;

export async function loadUsage(paths: Paths): Promise<UsageDb> {
	const db = await readJson<UsageDb>(paths.usagePath, { version: USAGE_DB_VERSION, cursors: {}, events: [] });
	return db.version === USAGE_DB_VERSION ? db : { version: USAGE_DB_VERSION, cursors: {}, events: [] };
}

export async function saveUsage(paths: Paths, db: UsageDb): Promise<void> {
	await writeJsonAtomic(paths.usagePath, db, 0);
}

/** `file` events that belong to a bulk SKILL.md scan within one session file. */
export function bulkFileReads(events: UsageEvent[]): Set<UsageEvent> {
	const bySource = new Map<string, UsageEvent[]>();
	for (const event of events) {
		if (event.kind !== "file") continue;
		const list = bySource.get(event.src);
		if (list) list.push(event);
		else bySource.set(event.src, [event]);
	}
	const bulk = new Set<UsageEvent>();
	for (const list of bySource.values()) {
		list.sort((a, b) => a.at.localeCompare(b.at));
		const times = list.map(event => new Date(event.at).getTime());
		let start = 0;
		for (let end = 0; end < list.length; end++) {
			while (times[end]! - times[start]! > BULK_WINDOW_MS) start++;
			const window = list.slice(start, end + 1);
			if (new Set(window.map(event => event.skill)).size >= BULK_DISTINCT_SKILLS) {
				for (const event of window) bulk.add(event);
			}
		}
	}
	return bulk;
}

/** Fold raw events into per-skill usage. Mentions are tallied apart and never count as use. */
export function aggregate(events: UsageEvent[]): Map<string, SkillUsage> {
	const bulk = bulkFileReads(events);
	const out = new Map<string, SkillUsage>();
	for (const event of events) {
		let usage = out.get(event.skill);
		if (!usage) {
			usage = { uses: 0, byHarness: {}, byKind: {}, mentions: 0 };
			out.set(event.skill, usage);
		}
		if (event.kind === "mention" || bulk.has(event)) {
			usage.mentions++;
			if (!usage.lastMention || event.at > usage.lastMention) usage.lastMention = event.at;
			continue;
		}
		usage.uses++;
		usage.byHarness[event.harness] = (usage.byHarness[event.harness] ?? 0) + 1;
		usage.byKind[event.kind] = (usage.byKind[event.kind] ?? 0) + 1;
		if (!usage.lastUsed || event.at > usage.lastUsed) usage.lastUsed = event.at;
		if (!usage.firstUsed || event.at < usage.firstUsed) usage.firstUsed = event.at;
	}
	return out;
}

/** Combine usage recorded under several names of one skill (directory and registered name). */
export function mergeUsage(parts: Array<SkillUsage | undefined>): SkillUsage | undefined {
	const present = parts.filter((part): part is SkillUsage => part !== undefined);
	if (present.length <= 1) return present[0];
	const merged: SkillUsage = { uses: 0, byHarness: {}, byKind: {}, mentions: 0 };
	for (const part of present) {
		merged.uses += part.uses;
		merged.mentions += part.mentions;
		for (const [harness, count] of Object.entries(part.byHarness)) merged.byHarness[harness] = (merged.byHarness[harness] ?? 0) + count;
		for (const [kind, count] of Object.entries(part.byKind) as Array<[UsageKind, number]>) merged.byKind[kind] = (merged.byKind[kind] ?? 0) + count;
		if (part.lastUsed && (!merged.lastUsed || part.lastUsed > merged.lastUsed)) merged.lastUsed = part.lastUsed;
		if (part.firstUsed && (!merged.firstUsed || part.firstUsed < merged.firstUsed)) merged.firstUsed = part.firstUsed;
		if (part.lastMention && (!merged.lastMention || part.lastMention > merged.lastMention)) merged.lastMention = part.lastMention;
	}
	return merged;
}
