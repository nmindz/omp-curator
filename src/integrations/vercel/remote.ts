import { spawnSync } from "node:child_process";
import { cp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { exists, stamp } from "../../fsutil.ts";
import type { Paths } from "../../paths.ts";
import { linkStatus } from "./link.ts";
import { readLock } from "./lock.ts";
import type { SkillLockEntry } from "./lock.ts";

export interface GithubTree {
	sha: string;
	tree: Array<{ path: string; type: string; sha: string }>;
}

export interface CommandResult {
	ok: boolean;
	output: string;
}

/** Process and network seams, swapped out in tests. */
export interface RemoteDeps {
	run(command: string, args: string[]): CommandResult;
	fetchTree(source: string, ref: string | undefined): Promise<GithubTree | undefined>;
}

export const defaultRemoteDeps: RemoteDeps = {
	run(command, args) {
		const result = spawnSync(command, args, {
			encoding: "utf8",
			env: { ...process.env, DISABLE_TELEMETRY: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.error) return { ok: false, output: result.error.message };
		return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
	},
	async fetchTree(source, ref) {
		// `gh api` applies the user's stored GitHub auth (private repos, rate limits).
		const route = `repos/${source}/git/trees/${encodeURIComponent(ref ?? "HEAD")}?recursive=1`;
		const gh = spawnSync("gh", ["api", route], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		if (gh.status === 0 && gh.stdout) return JSON.parse(gh.stdout) as GithubTree;
		const response = await fetch(`https://api.github.com/${route}`, { headers: { Accept: "application/vnd.github+json" } });
		return response.ok ? ((await response.json()) as GithubTree) : undefined;
	},
};

/** `skills add` argument that reinstalls a lock entry (vercel-labs/skills `buildUpdateInstallSource`). */
export function installSource(entry: SkillLockEntry): string {
	const base = entry.sourceType === "github" ? entry.source : entry.sourceUrl || entry.source;
	const folder = (entry.skillPath ?? "").replace(/\/?SKILL\.md$/i, "");
	const appendable = (entry.sourceType === "github" || entry.sourceType === "gitlab") && !base.endsWith(".git");
	const withFolder = appendable && folder ? `${base}/${folder}` : base;
	return entry.ref ? `${withFolder}#${entry.ref}` : withFolder;
}

/** Tree SHA of a skill folder (vercel-labs/skills `getSkillFolderHashFromTree`). */
export function folderHashFromTree(tree: GithubTree, skillPath: string): string | undefined {
	const folder = skillPath.replace(/\\/g, "/").replace(/\/?SKILL\.md$/i, "").replace(/\/$/, "");
	if (!folder) return tree.sha;
	return tree.tree.find(item => item.type === "tree" && item.path === folder)?.sha;
}

/**
 * `-a pi` targets a universal `skills` agent, so the install lands only in `~/.agents/skills`
 * (the OMP store). A bare `skills update` instead symlinks every detected harness.
 */
export function installArgs(source: string, name: string): string[] {
	return ["add", source, "--skill", name, "-g", "-a", "pi", "-y"];
}

export interface UpdateItem {
	name: string;
	status: "current" | "updated" | "outdated" | "failed" | "skipped";
	detail?: string;
}

/**
 * `skills` installs universal agents into `~/.agents/skills`; unless that is the store link,
 * an install would land outside OMP while the lock claims it is current.
 */
async function requireLinked(paths: Paths): Promise<void> {
	const status = await linkStatus(paths);
	if (status.kind !== "linked") {
		throw new Error(`${paths.agentsSkillsDir} is not linked to the OMP store (${status.kind}); run \`omp-curator link\` first`);
	}
}

/** Compare GitHub-tracked lock entries with upstream tree SHAs and reinstall changed ones. */
export async function updateSkills(
	paths: Paths,
	skillsCommand: string,
	options: { names?: string[]; dryRun: boolean; active: Set<string> },
	deps: RemoteDeps = defaultRemoteDeps,
): Promise<UpdateItem[]> {
	if (!options.dryRun) await requireLinked(paths);
	const lock = await readLock(paths);
	const items: UpdateItem[] = [];
	const trees = new Map<string, Promise<GithubTree | undefined>>();
	for (const [name, entry] of Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) {
		if (options.names?.length && !options.names.includes(name)) continue;
		if (!options.active.has(name)) {
			items.push({ name, status: "skipped", detail: "not in the OMP store" });
			continue;
		}
		if (entry.sourceType !== "github" || !entry.skillPath || !/^[0-9a-f]{40}$/i.test(entry.skillFolderHash)) {
			const command = [skillsCommand, ...installArgs(installSource(entry), name)].join(" ");
			items.push({ name, status: "skipped", detail: `no tree-hash tracking (${entry.sourceType}); reinstall with: ${command}` });
			continue;
		}
		const treeKey = `${entry.source}#${entry.ref ?? ""}`;
		if (!trees.has(treeKey)) trees.set(treeKey, deps.fetchTree(entry.source, entry.ref).catch(() => undefined));
		const tree = await trees.get(treeKey);
		const latest = tree && folderHashFromTree(tree, entry.skillPath);
		if (!latest) {
			items.push({ name, status: "failed", detail: `cannot read the ${entry.source} tree` });
			continue;
		}
		if (latest === entry.skillFolderHash) {
			items.push({ name, status: "current" });
		} else if (options.dryRun) {
			items.push({ name, status: "outdated", detail: `${entry.skillFolderHash.slice(0, 7)} → ${latest.slice(0, 7)}` });
		} else {
			const run = deps.run(skillsCommand, installArgs(installSource(entry), name));
			items.push({ name, status: run.ok ? "updated" : "failed", detail: run.ok ? undefined : run.output.split("\n").slice(-3).join(" ") });
		}
	}
	return items;
}

/**
 * Put a store skill under `skills` version tracking by reinstalling it from `source`.
 * The current copy is backed up first because upstream content replaces it.
 */
export async function trackSkill(
	paths: Paths,
	skillsCommand: string,
	name: string,
	source: string,
	deps: RemoteDeps = defaultRemoteDeps,
): Promise<{ backup?: string; output: string }> {
	await requireLinked(paths);
	const current = join(paths.skillsDir, name);
	let backup: string | undefined;
	if (await exists(current)) {
		backup = join(paths.backupDir, `${name}@${stamp()}`);
		await mkdir(paths.backupDir, { recursive: true });
		// Copy resolved content: a symlinked skill's relative target would dangle from the backup dir.
		await cp(await realpath(current), backup, { recursive: true, dereference: true });
	}
	const run = deps.run(skillsCommand, installArgs(source, name));
	if (!run.ok) throw new Error(`${skillsCommand} add failed:\n${run.output}`);
	if (!(await readLock(paths)).skills[name]) {
		throw new Error(`${skillsCommand} add wrote no lock entry for "${name}"; check that ${source} publishes a skill with that name`);
	}
	return { backup, output: run.output };
}

export interface SourceCandidate {
	source: string;
	installs: number;
	slug: string;
}

/** Search skills.sh for published skills named exactly like `name`, most installed first. */
export async function findSources(name: string): Promise<SourceCandidate[]> {
	const response = await fetch(`https://skills.sh/api/search?${new URLSearchParams({ q: name, limit: "20" })}`);
	if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`);
	const data = (await response.json()) as { skills?: Array<{ id: string; name: string; installs: number; source?: string }> };
	return (data.skills ?? [])
		.filter(skill => skill.name === name && skill.source)
		.map(skill => ({ source: skill.source!, installs: skill.installs, slug: skill.id }))
		.sort((a, b) => b.installs - a.installs);
}
