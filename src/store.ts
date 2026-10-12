import { readFile } from "node:fs/promises";
import { appendJsonLine, readJson, writeJsonAtomic } from "./fsutil.ts";
import type { Paths } from "./paths.ts";

export interface CuratorConfig {
	/** Idle days after which an installed skill is reported as stale. */
	staleAfterDays: number;
	/** Idle days after which an unprotected skill is archived by the automatic pass. */
	archiveAfterDays: number;
	/** Minimum hours between automatic passes started by the OMP extension. */
	intervalHours: number;
	/** When false the automatic pass only labels skills; archiving stays manual. */
	autoArchive: boolean;
	/** Restore an archived skill when an agent tries to read it via `skill://`. */
	autoRestoreOnRead: boolean;
	/** Glob patterns (`*` wildcard) of skills never archived automatically. */
	protect: string[];
	/** Usage sources by id (see `USAGE_SOURCES`); a missing id means enabled. */
	sources: Record<string, boolean>;
	/** Vercel `skills` CLI command used by `update` and `track`. */
	skillsCommand: string;
}

export const DEFAULT_CONFIG: CuratorConfig = {
	staleAfterDays: 30,
	archiveAfterDays: 90,
	intervalHours: 168,
	autoArchive: true,
	autoRestoreOnRead: true,
	protect: [],
	sources: { omp: true, claude: true, opencode: true },
	skillsCommand: "skills",
};

export type SkillState = "active" | "stale" | "archived";

export interface ArchiveRecord {
	/** Absolute path of the archived entry under the curator archive root. */
	path: string;
	at: string;
	reason: string;
	/** Data integrations removed when archiving (e.g. the `skills` lock entry), keyed by integration id. */
	stash?: Record<string, unknown>;
	/** Set while an archive is in flight; reconciled by `sync()` if the process died midway. */
	pending?: boolean;
}

export interface SkillRecord {
	firstSeen: string;
	/** Idle time is measured from max(last use, floor); set on first sight, restore and reinstall. */
	floorAt: string;
	state: SkillState;
	stateSince: string;
	pinned?: boolean;
	/** Frontmatter name when it differs from the directory; OMP registers the skill under it. */
	registeredName?: string;
	/** Store entry identity last seen; a change means the skill was reinstalled. */
	entryId?: string;
	archive?: ArchiveRecord;
}

export interface CuratorState {
	version: 1;
	initializedAt?: string;
	lastRunAt?: string;
	skills: Record<string, SkillRecord>;
}

export interface LedgerEntry {
	at: string;
	actor: "user" | "auto" | "extension";
	action: string;
	skill?: string;
	detail?: string;
}

export async function loadConfig(paths: Paths): Promise<CuratorConfig> {
	const stored = await readJson<Partial<CuratorConfig>>(paths.configPath, {});
	return { ...DEFAULT_CONFIG, ...stored, sources: { ...DEFAULT_CONFIG.sources, ...stored.sources } };
}

export async function loadState(paths: Paths): Promise<CuratorState> {
	const state = await readJson<CuratorState>(paths.statePath, { version: 1, skills: {} });
	// Skill names are directory names; a skill called `constructor` must not hit Object.prototype.
	state.skills = Object.assign(Object.create(null) as Record<string, SkillRecord>, state.skills);
	return state;
}

export async function saveState(paths: Paths, state: CuratorState): Promise<void> {
	await writeJsonAtomic(paths.statePath, state);
}

export async function appendLedger(paths: Paths, entry: Omit<LedgerEntry, "at">): Promise<void> {
	await appendJsonLine(paths.ledgerPath, { at: new Date().toISOString(), ...entry });
}

export async function readLedger(paths: Paths, limit: number): Promise<LedgerEntry[]> {
	let text: string;
	try {
		text = await readFile(paths.ledgerPath, "utf8");
	} catch {
		return [];
	}
	const lines = text.trim().split("\n").filter(Boolean);
	return lines.slice(-limit).map(line => JSON.parse(line) as LedgerEntry);
}
