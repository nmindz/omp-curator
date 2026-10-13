import type { Paths } from "../paths.ts";

/**
 * `read`       loaded through the harness skill mechanism (OMP `skill://`)
 * `file`       a SKILL.md read by path; reclassified as a mention when part of a bulk scan
 * `command`    user invoked it (`/skill:<name>`, a Claude slash command)
 * `autoload`   injected into a subagent through `autoloadSkills`
 * `skill-tool` a native skill tool call (Claude Code `Skill`, OpenCode `skill`)
 * `mention`    a shell command touched the skill directory; weak evidence, never counted as use
 */
export type UsageKind = "read" | "file" | "command" | "autoload" | "skill-tool" | "mention";

export interface UsageEvent {
	skill: string;
	at: string;
	/** Id of the {@link UsageSource} that produced the event. */
	harness: string;
	kind: UsageKind;
	/** Session the event belongs to: its file, or `<db>#<session>`. Bulk detection groups by it. */
	src: string;
	/** Source-specific record id for sources that can re-deliver a record (OpenCode part id). */
	id?: string;
}

export interface Cursor {
	size: number;
	mtimeMs: number;
	/** Bytes consumed (JSONL) or the highest row timestamp seen (databases). */
	offset: number;
	/** Inode of the file the cursor belongs to (JSONL sources). */
	ino?: number;
	/** Digest of the bytes just before `offset` (JSONL sources), to detect rewrites. */
	tail?: string;
	/** Size of the SQLite WAL file (database sources). */
	wal?: string;
}

/** A subagent spawned from an agent definition (OMP `task`, Claude Code `Task`/`Agent`). */
export interface AgentSpawn {
	agent: string;
	at: string;
	harness: string;
	/** Cursor key of the file the spawn came from; a rewritten file replaces its spawns. */
	src: string;
}

export interface UsageDb {
	version: number;
	cursors: Record<string, Cursor>;
	events: UsageEvent[];
	spawns?: AgentSpawn[];
	/** Set once spawns were backfilled from history scanned before spawns were recorded. */
	spawnsBackfilled?: boolean;
}

export interface ScanResult {
	added: number;
	files: number;
	/** Nothing of the harness is on disk (never installed, or uninstalled and purged). */
	missing?: boolean;
	/** The source could not be read; its earlier evidence is kept. */
	error?: string;
}

export interface ScanContext {
	paths: Paths;
	db: UsageDb;
	/** Installed and archived skill names, used to resolve namespaced URLs and shell mentions. */
	known: Set<string>;
}

/**
 * A session history that can prove a skill was used. Sources scan incrementally: they keep
 * their own cursors in `ctx.db.cursors` and append to `ctx.db.events`.
 */
export interface UsageSource {
	id: string;
	description: string;
	/** Where the harness keeps its history; the source counts as missing when none exists. */
	locations(paths: Paths): string[];
	/**
	 * A required source that fails aborts the scan. Optional ones (other harnesses, which
	 * may be uninstalled at any time) only warn, and their recorded evidence stays.
	 */
	required?: boolean;
	scan(ctx: ScanContext): Promise<ScanResult>;
	/** Record agent spawns from history already scanned before spawns were tracked. */
	backfillSpawns?(ctx: ScanContext): Promise<void>;
}
