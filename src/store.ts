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
	/** Also archive `due` agent definitions during automatic passes (off: agents are only labelled). */
	autoArchiveAgents: boolean;
	/**
	 * Archived skills stay loadable: `skill://` reads are redirected to the archive and
	 * `/skill:` works. When false, archived skills are unreachable until restored.
	 */
	lazyLoad: boolean;
	/** Suggest dormant skills that match the user's prompt (hidden context, no prompt cost otherwise). */
	hints: boolean;
	/** Minimum relevance score for a prompt hint; raise it if hints are noisy. */
	hintMinScore: number;
	/** Restore a dormant skill on the next pass once it was lazy-loaded this many times within `staleAfterDays` (0 disables). */
	promoteAfterUses: number;
	/**
	 * Keep at most this many skills in context (0 = no cap). Past the cap, the least used
	 * unprotected skills outside their `staleAfterDays` grace are archived by the pass.
	 */
	maxActive: number;
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
	autoArchiveAgents: false,
	lazyLoad: true,
	hints: true,
	hintMinScore: 10,
	promoteAfterUses: 2,
	maxActive: 0,
	protect: [],
	sources: { omp: true, claude: true, opencode: true, codex: true, dsh: true },
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
	/**
	 * `seen`: when the store entry appeared; `history`: lowered to the first recorded use when
	 * `init` adopted an existing library; `reset`: an explicit restore or reinstall.
	 */
	floorSource?: "seen" | "history" | "reset";
	state: SkillState;
	stateSince: string;
	pinned?: boolean;
	/** Frontmatter name when it differs from the directory; OMP registers the skill under it. */
	registeredName?: string;
	/** Store entry identity last seen; a change means the skill was reinstalled. */
	entryId?: string;
	archive?: ArchiveRecord;
}

/** Lifecycle of an agent definition (`~/.omp/agent/agents/<name>.md`). */
export interface AgentRecord {
	firstSeen: string;
	/** Idle time is measured from max(last spawn, floor). */
	floorAt: string;
	state: SkillState;
	stateSince: string;
	pinned?: boolean;
	archive?: { path: string; at: string; reason: string; pending?: boolean };
}

export interface CuratorState {
	version: 1;
	initializedAt?: string;
	lastRunAt?: string;
	skills: Record<string, SkillRecord>;
	agents: Record<string, AgentRecord>;
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
	// Keys of retired options are dropped so they are not written back.
	const known = Object.fromEntries(Object.entries(stored).filter(([key]) => Object.hasOwn(DEFAULT_CONFIG, key)));
	return { ...DEFAULT_CONFIG, ...known, sources: { ...DEFAULT_CONFIG.sources, ...stored.sources } };
}

export async function loadState(paths: Paths): Promise<CuratorState> {
	const state = await readJson<CuratorState>(paths.statePath, { version: 1, skills: {}, agents: {} });
	// Skill names are directory names; a skill called `constructor` must not hit Object.prototype.
	state.skills = Object.assign(Object.create(null) as Record<string, SkillRecord>, state.skills);
	state.agents = Object.assign(Object.create(null) as Record<string, AgentRecord>, state.agents);
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
