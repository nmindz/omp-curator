import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter, strictYamlIssues } from "./frontmatter.ts";
import type { Paths } from "./paths.ts";

export interface SkillEntry {
	/** Directory name inside the store; OMP and `skills` both key skills by it. */
	name: string;
	path: string;
	realPath: string;
	/** Absolute symlink target when the store entry is a link (e.g. installer-managed skills). */
	linkTarget?: string;
	frontmatterName?: string;
	description?: string;
	hidden: boolean;
	/** When this entry appeared in the store (its own creation time, not a link target's). */
	createdAt: Date;
	/** Identity of the store entry; changes when an installer recreates it. */
	entryId: string;
	problems: string[];
}

/** Read every `<root>/<name>/SKILL.md` entry (directories or symlinks to directories). */
export async function listSkills(root: string): Promise<SkillEntry[]> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return [];
	}
	const entries: SkillEntry[] = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		const entry = await readSkill(join(root, name), name);
		if (entry) entries.push(entry);
	}
	return entries;
}

/** Store entries OMP cannot load: dangling symlinks and directories without a SKILL.md. */
export async function brokenEntries(root: string): Promise<Array<{ name: string; reason: string }>> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return [];
	}
	const broken: Array<{ name: string; reason: string }> = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		const path = join(root, name);
		const info = await stat(path).catch(() => undefined);
		if (!info) broken.push({ name, reason: `dangling symlink → ${await readlink(path).catch(() => "?")}` });
		else if (info.isDirectory() && !(await stat(join(path, "SKILL.md")).catch(() => undefined))) broken.push({ name, reason: "no SKILL.md" });
	}
	return broken;
}

export async function readSkill(path: string, name: string): Promise<SkillEntry | undefined> {
	let info;
	try {
		info = await stat(path);
	} catch {
		return undefined; // dangling symlink
	}
	if (!info.isDirectory()) return undefined;
	let text: string;
	try {
		text = await readFile(join(path, "SKILL.md"), "utf8");
	} catch {
		return undefined;
	}
	// The store entry itself, not a link target: availability is when it appeared in the store.
	const link = await lstat(path);
	const linkTarget = link.isSymbolicLink() ? resolve(dirname(path), await readlink(path)) : undefined;
	const meta = parseFrontmatter(text);
	const problems: string[] = [];
	const frontmatterName = typeof meta?.name === "string" ? meta.name : undefined;
	const description = typeof meta?.description === "string" ? meta.description : undefined;
	if (!meta) problems.push("missing frontmatter");
	if (!description) problems.push("missing description (OMP native discovery skips it)");
	if (frontmatterName && frontmatterName !== name) problems.push(`frontmatter name "${frontmatterName}" differs from directory`);
	problems.push(...strictYamlIssues(text));
	return {
		name,
		path,
		realPath: await realpath(path),
		linkTarget,
		frontmatterName,
		description,
		hidden: meta?.hide === true || meta?.["disable-model-invocation"] === true,
		createdAt: new Date(link.birthtimeMs > 0 ? link.birthtimeMs : link.mtimeMs),
		entryId: `${link.ino}:${link.birthtimeMs || link.mtimeMs}`,
		problems,
	};
}

/** Skills referenced by OMP agent `autoloadSkills`, mapped to the agents that need them. */
export async function autoloadReferences(paths: Paths): Promise<Map<string, string[]>> {
	const refs = new Map<string, string[]>();
	let files: string[];
	try {
		files = await readdir(paths.agentDefsDir);
	} catch {
		return refs;
	}
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const meta = parseFrontmatter(await readFile(join(paths.agentDefsDir, file), "utf8"));
		for (const skill of autoloadList(meta)) refs.set(skill, [...(refs.get(skill) ?? []), file.slice(0, -3)]);
	}
	return refs;
}

/** An agent's `autoloadSkills`: OMP accepts a YAML list or a comma-separated string (parseArrayOrCSV). */
export function autoloadList(meta: Record<string, unknown> | undefined): string[] {
	const raw = meta?.autoloadSkills ?? meta?.["autoload-skills"];
	const skills = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
	return skills.map(item => String(item).trim()).filter(Boolean);
}
