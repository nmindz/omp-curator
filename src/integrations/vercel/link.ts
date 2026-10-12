import { lstat, mkdir, readdir, readlink, realpath, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hashTree, moveEntry, stamp } from "../../fsutil.ts";
import type { Paths } from "../../paths.ts";

export type LinkStatus =
	| { kind: "linked" }
	| { kind: "missing" }
	| { kind: "directory" }
	| { kind: "foreign-symlink"; target: string };

/** Whether `~/.agents/skills` (the `skills` canonical global root) points at the OMP store. */
export async function linkStatus(paths: Paths): Promise<LinkStatus> {
	let info;
	try {
		info = await lstat(paths.agentsSkillsDir);
	} catch {
		return { kind: "missing" };
	}
	if (!info.isSymbolicLink()) return { kind: "directory" };
	const target = resolve(dirname(paths.agentsSkillsDir), await readlink(paths.agentsSkillsDir));
	const [real, store] = await Promise.all([
		realpath(target).catch(() => target),
		realpath(paths.skillsDir).catch(() => paths.skillsDir),
	]);
	return real === store ? { kind: "linked" } : { kind: "foreign-symlink", target };
}

export interface LinkReport {
	before: LinkStatus["kind"];
	moved: string[];
	/** Store entries that were symlinks into `~/.agents/skills`, replaced by the real directory. */
	replacedAliases: string[];
	duplicates: string[];
	conflicts: Array<{ name: string; keptAt: string }>;
	removedJunk: string[];
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

async function sameContent(a: string, b: string): Promise<boolean> {
	try {
		return (await hashTree(a)) === (await hashTree(b));
	} catch {
		return false;
	}
}

/**
 * Make `~/.agents/skills` a symlink to the OMP store, so `skills add -g` installs straight
 * into OMP and `skills ls -g` lists every OMP skill. Existing entries move into the store.
 * A store entry that merely links into `~/.agents/skills` is replaced by the real directory;
 * an independent identical copy is dropped; a differing one is parked under the conflicts dir.
 */
export async function linkAgentsDir(paths: Paths, dryRun: boolean): Promise<LinkReport> {
	const status = await linkStatus(paths);
	const report: LinkReport = { before: status.kind, moved: [], replacedAliases: [], duplicates: [], conflicts: [], removedJunk: [] };
	if (status.kind === "linked") return report;
	if (status.kind === "foreign-symlink") {
		throw new Error(`${paths.agentsSkillsDir} links to ${status.target}; remove that link before omp-curator can manage it`);
	}
	if (status.kind === "directory") {
		const canonical = await realpath(paths.agentsSkillsDir);
		const storeReal = await realpath(paths.skillsDir).catch(() => undefined);
		if (storeReal && (isWithin(storeReal, canonical) || isWithin(canonical, storeReal))) {
			throw new Error(`${paths.skillsDir} and ${paths.agentsSkillsDir} resolve into each other; make the OMP store a real directory first`);
		}
		for (const name of (await readdir(paths.agentsSkillsDir)).sort()) {
			const src = join(paths.agentsSkillsDir, name);
			const dest = join(paths.skillsDir, name);
			if (name === ".DS_Store") {
				report.removedJunk.push(name);
				if (!dryRun) await rm(src, { force: true });
				continue;
			}
			const destInfo = await lstat(dest).catch(() => undefined);
			const destReal = destInfo ? await realpath(dest).catch(() => undefined) : undefined;
			if (!destInfo) {
				report.moved.push(name);
				if (!dryRun) await moveEntry(src, dest);
			} else if (destInfo.isSymbolicLink() && (!destReal || isWithin(destReal, canonical))) {
				// The store entry is an alias of (or a dangling link into) the dir being replaced.
				report.replacedAliases.push(name);
				if (!dryRun) {
					await rm(dest);
					await moveEntry(src, dest);
				}
			} else if (destReal && (destReal === (await realpath(src).catch(() => src)) || (await sameContent(src, dest)))) {
				report.duplicates.push(name);
				if (!dryRun) await rm(src, { recursive: true, force: true });
			} else {
				const keptAt = join(paths.conflictsDir, `${name}@${stamp()}`);
				report.conflicts.push({ name, keptAt });
				if (!dryRun) await moveEntry(src, keptAt);
			}
		}
		if (!dryRun) await rmdir(paths.agentsSkillsDir);
	}
	if (!dryRun) {
		await mkdir(dirname(paths.agentsSkillsDir), { recursive: true });
		await mkdir(paths.skillsDir, { recursive: true });
		await symlink(paths.skillsDir, paths.agentsSkillsDir);
	}
	return report;
}

/** Replace the `~/.agents/skills` link with an empty directory; the OMP store is untouched. */
export async function unlinkAgentsDir(paths: Paths): Promise<void> {
	const status = await linkStatus(paths);
	if (status.kind !== "linked") throw new Error(`${paths.agentsSkillsDir} is not linked to the OMP store (${status.kind})`);
	await rm(paths.agentsSkillsDir);
	await mkdir(paths.agentsSkillsDir);
}

/**
 * Global skill dirs of non-universal `skills` agents. A bare `skills add -g` or
 * `skills update` symlinks every detected agent; links into the store show up here.
 */
export const FOREIGN_AGENT_DIRS = [
	".claude/skills",
	".config/opencode/skills",
	".gemini/skills",
	".copilot/skills",
	".cursor/skills",
	".codeium/windsurf/skills",
	".kiro/skills",
	".factory/skills",
	".config/goose/skills",
	".qwen/skills",
	".roo/skills",
	".hermes/skills",
	".openclaw/skills",
	".grok/skills",
	".config/agents/skills",
];

export interface StrayLink {
	path: string;
	target: string;
}

/** Symlinks in other harnesses' skill dirs that resolve into the OMP store. */
export async function findStrayLinks(paths: Paths): Promise<StrayLink[]> {
	const store = await realpath(paths.skillsDir).catch(() => paths.skillsDir);
	const strays: StrayLink[] = [];
	for (const rel of FOREIGN_AGENT_DIRS) {
		const dir = join(paths.home, rel);
		// A harness dir that is itself an alias of the store lists store entries, not strays.
		const dirReal = await realpath(dir).catch(() => undefined);
		if (!dirReal || isWithin(dirReal, store) || isWithin(store, dirReal)) continue;
		for (const name of await readdir(dir)) {
			const path = join(dir, name);
			if (!(await lstat(path)).isSymbolicLink()) continue;
			const target = await realpath(path).catch(() => undefined);
			if (target && isWithin(target, store)) strays.push({ path, target });
		}
	}
	return strays;
}

/** Harness skill dirs that are themselves symlinks to (or into) the OMP store. */
export async function aliasedHarnessDirs(paths: Paths): Promise<string[]> {
	const store = await realpath(paths.skillsDir).catch(() => paths.skillsDir);
	const aliased: string[] = [];
	for (const rel of FOREIGN_AGENT_DIRS) {
		const dir = join(paths.home, rel);
		const dirReal = await realpath(dir).catch(() => undefined);
		if (dirReal && isWithin(dirReal, store)) aliased.push(dir);
	}
	return aliased;
}
