import { readJson, writeJsonAtomic } from "../../fsutil.ts";
import type { Paths } from "../../paths.ts";

/** Lock schema written by vercel-labs/skills (`src/skill-lock.ts`, version 3). */
export interface SkillLockEntry {
	source: string;
	sourceType: string;
	sourceUrl: string;
	ref?: string;
	skillPath?: string;
	skillFolderHash: string;
	installedAt: string;
	updatedAt: string;
	pluginName?: string;
	sourceBaseUrl?: string;
	wellKnownDigest?: string;
	[key: string]: unknown;
}

export interface SkillLock {
	version: number;
	skills: Record<string, SkillLockEntry>;
	/** `dismissed`, `lastSelectedAgents` and future fields are preserved verbatim. */
	[key: string]: unknown;
}

export const LOCK_VERSION = 3;

export async function readLock(paths: Paths): Promise<SkillLock> {
	const lock = await readJson<SkillLock>(paths.lockPath, { version: LOCK_VERSION, skills: {} });
	// `skills` discards locks older than v3; mirror that instead of upgrading them.
	if (typeof lock.version !== "number" || lock.version < LOCK_VERSION || !lock.skills) {
		return { version: LOCK_VERSION, skills: {} };
	}
	return lock;
}

export async function writeLock(paths: Paths, lock: SkillLock): Promise<void> {
	await writeJsonAtomic(paths.lockPath, lock);
}
