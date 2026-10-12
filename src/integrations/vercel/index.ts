import { readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../../fsutil.ts";
import type { Finding, Integration } from "../types.ts";
import { aliasedHarnessDirs, findStrayLinks, linkStatus } from "./link.ts";
import { readLock, writeLock } from "./lock.ts";
import type { SkillLockEntry } from "./lock.ts";

/**
 * Keeps the vercel-labs/skills global lock consistent with the store. Archiving removes the
 * lock entry (otherwise `skills update` would reinstall the skill) and restore puts it back.
 * Every lookup uses `Object.hasOwn`: lock keys are skill names and may shadow prototype keys.
 */
export const vercelIntegration: Integration = {
	id: "vercel-skills",

	async beforeArchive({ paths }, name) {
		const lock = await readLock(paths);
		return Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
	},

	async afterArchive({ paths }, name, stashed) {
		const lock = await readLock(paths);
		const current = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
		// Only drop the entry captured at archive time; a newer one belongs to a reinstall.
		if (!current || JSON.stringify(current) !== JSON.stringify(stashed)) return;
		delete lock.skills[name];
		await writeLock(paths, lock);
	},

	async afterRestore({ paths }, name, stashed) {
		if (!stashed) return;
		const lock = await readLock(paths);
		// A reinstall while archived already wrote a fresher entry; keep it.
		if (Object.hasOwn(lock.skills, name)) return;
		lock.skills[name] = stashed as SkillLockEntry;
		await writeLock(paths, lock);
	},

	async origins({ paths }) {
		const lock = await readLock(paths);
		const origins: Record<string, string> = Object.create(null);
		for (const [name, entry] of Object.entries(lock.skills)) origins[name] = `skills:${entry.source}`;
		return origins;
	},

	async doctor({ paths }) {
		const findings: Finding[] = [];
		const status = await linkStatus(paths);
		if (status.kind === "linked") {
			findings.push({ level: "ok", message: `${paths.agentsSkillsDir} → OMP store` });
		} else {
			findings.push({
				level: "warn",
				message: `${paths.agentsSkillsDir} is ${status.kind === "foreign-symlink" ? `linked to ${status.target}` : status.kind}; skills installed with \`skills -g\` will not reach OMP`,
				fix: "omp-curator link",
			});
		}
		for (const stray of await findStrayLinks(paths)) {
			findings.push({
				level: "warn",
				message: `${stray.path} is a \`skills\` symlink into the OMP store (another harness sees the skill)`,
				fix: "omp-curator doctor --fix",
			});
		}
		for (const dir of await aliasedHarnessDirs(paths)) {
			findings.push({
				level: "warn",
				message: `${dir} is a symlink into the OMP store, so that harness loads every OMP skill`,
				fix: `rm ${dir}`,
			});
		}
		const lock = await readLock(paths);
		for (const name of Object.keys(lock.skills)) {
			if (!(await exists(join(paths.skillsDir, name)))) {
				findings.push({ level: "warn", message: `lock entry "${name}" has no skill in the store`, fix: `skills remove -g ${name}` });
			}
		}
		return findings;
	},

	async fix({ paths }) {
		const changes: string[] = [];
		const parents = new Set<string>();
		for (const stray of await findStrayLinks(paths)) {
			await rm(stray.path);
			parents.add(dirname(stray.path));
			changes.push(`removed ${stray.path}`);
		}
		// `skills add` creates a harness skills dir just to hold its symlinks; drop it once empty.
		for (const dir of parents) {
			if ((await readdir(dir)).length === 0) {
				await rmdir(dir);
				changes.push(`removed empty ${dir}`);
			}
		}
		return changes;
	},
};
