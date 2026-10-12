import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Curator } from "./curator.ts";
import { dormantDir, resolveSkillUrl, skillBody } from "./dormant.ts";
import type { DormantIndex } from "./dormant.ts";
import { exists } from "./fsutil.ts";
import { CURATOR_SKILL } from "./usage/sources/omp.ts";

/** Custom message type for dormant skills invoked with `/skill:` or `/curator load`. */
export const SKILL_INVOCATION_TYPE = CURATOR_SKILL;
export const HINT_TYPE = "omp-curator-hint";

/** Where a `read skill://…` of a dormant skill should go instead (the archived file). */
export function dormantRedirect(curator: Curator, url: string): { name: string; path: string } | undefined {
	if (!curator.config.lazyLoad) return undefined;
	return resolveSkillUrl(url, name => dormantDir(curator, name));
}

/**
 * Content for a `skill://` read that OMP could not resolve although the skill exists: it
 * was restored or installed after this session loaded its skill list. Selectors are not
 * applied; the whole file (or a directory listing) is returned.
 */
export async function fallbackRead(curator: Curator, url: string): Promise<{ name: string; text: string } | undefined> {
	const target = resolveSkillUrl(url, name => {
		const key = curator.resolveName(name);
		if (!key) return undefined;
		return curator.state.skills[key]?.state === "archived" ? dormantDir(curator, key) : join(curator.paths.skillsDir, key);
	});
	if (!target) return undefined;
	const file = target.path.replace(/:[^/]*$/, "");
	if (!(await exists(file))) return undefined;
	if ((await stat(file)).isDirectory()) return { name: target.name, text: (await readdir(file)).sort().join("\n") };
	return { name: target.name, text: await readFile(file, "utf8") };
}

/**
 * Hidden context naming dormant skills that match the user's prompt. Each skill is hinted
 * once per session; nothing is returned when no skill clears `hintMinScore`.
 */
export function hintFor(index: DormantIndex, prompt: string, minScore: number, alreadyHinted: Set<string>): { text: string; names: string[] } | undefined {
	const hits = index
		.search(prompt, 3)
		.filter(hit => hit.score >= minScore && !alreadyHinted.has(hit.skill.name) && !prompt.includes(`skill://${hit.skill.name}`));
	if (!hits.length) return undefined;
	const lines = hits.map(hit => {
		const name = hit.skill.registeredName ?? hit.skill.name;
		const description = hit.skill.description.length > 200 ? `${hit.skill.description.slice(0, 197)}…` : hit.skill.description;
		return `- ${name}: ${description} (read skill://${name})`;
	});
	return {
		names: hits.map(hit => hit.skill.name),
		text: [
			"omp-curator: dormant skills that match this request. They are not in your skill list because they are rarely used, but they load normally with the read tool:",
			...lines,
			"Load one before relying on it; ignore them if they do not apply.",
		].join("\n"),
	};
}

/** `skill_search` tool and CLI output. An empty query lists every dormant skill; the CLI shows scores. */
export function formatSearch(index: DormantIndex, query: string, limit: number, withScores = false): string {
	const hits = query.trim()
		? index.search(query, limit)
		: index.skills.slice(0, limit).map(skill => ({ skill, score: 0, matched: [] as string[] }));
	if (!hits.length) return query.trim() ? `No dormant skill matches "${query}".` : "There are no dormant skills.";
	return [
		`${hits.length} dormant skill(s)${query.trim() ? ` matching "${query}"` : ""}. Load one with read skill://<name>.`,
		...hits.map(hit => `- ${withScores && hit.score ? `[${hit.score.toFixed(1)}] ` : ""}${hit.skill.registeredName ?? hit.skill.name}: ${hit.skill.description}`),
	].join("\n");
}

export interface InvocationMessage {
	content: string;
	details: { name: string; path: string; args?: string; lineCount: number };
}

/** User-invoked dormant skill, shaped like OMP's own `/skill:` message. */
export async function invocationMessage(curator: Curator, name: string, args: string): Promise<InvocationMessage | undefined> {
	if (!curator.config.lazyLoad) return undefined;
	const dir = dormantDir(curator, name);
	if (!dir) return undefined;
	const path = join(dir, "SKILL.md");
	const body = skillBody(await readFile(path, "utf8"));
	const content = [
		`The user invoked the skill "${name}" (loaded by omp-curator from its archive of rarely used skills). Follow it for this request.`,
		"",
		body,
		"",
		`[Skill directory: ${dir}]`,
		"Resolve relative paths in this skill (scripts, references, templates) against the skill directory.",
		...(args.trim() ? ["", `User: ${args.trim()}`] : []),
	].join("\n");
	return { content, details: { name, path, ...(args.trim() ? { args: args.trim() } : {}), lineCount: body.split("\n").length } };
}
