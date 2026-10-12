import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { Curator } from "./curator.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { listSkills } from "./inventory.ts";

/**
 * Dormant skills are archived: absent from the store, so OMP does not list them in the
 * prompt, yet the extension can still load them on demand.
 */
export interface DormantSkill {
	/** Store key (directory name). */
	name: string;
	/** Name OMP registers when the frontmatter name differs from the directory. */
	registeredName?: string;
	dir: string;
	description: string;
}

export interface SearchHit {
	skill: DormantSkill;
	score: number;
	/** Query terms that matched, most specific first. */
	matched: string[];
}

export interface DormantIndex {
	skills: DormantSkill[];
	search(query: string, limit?: number): SearchHit[];
}

const STOPWORDS = new Set(
	"the and for with that this from into your you are use using used when what which will can could should would about also only then than them they their there here have has had not but all any each how why who our out was were been being its it's per via etc more most some such other these those over under while where just like make made get set need want".split(
		" ",
	),
);

/** Lowercased content words; a trailing plural `s` is folded so "skills" matches "skill". */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
		out.push(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
	}
	return out;
}

interface Doc {
	nameTerms: Set<string>;
	descTerms: Set<string>;
}

/** Name terms weigh more than description terms: names are short and chosen to be specific. */
const NAME_WEIGHT = 3;

/**
 * Build a search index over dormant skills. Term rarity is measured over every skill the
 * curator knows (store and archive), so words common to many skills ("code", "file") barely
 * count and a hint fires only on terms that single out a skill.
 */
export async function buildDormantIndex(curator: Curator): Promise<DormantIndex> {
	const skills: DormantSkill[] = [];
	for (const [name, record] of Object.entries(curator.state.skills)) {
		if (record.state !== "archived" || !record.archive || record.archive.pending) continue;
		let description = "";
		try {
			const meta = parseFrontmatter(await readFile(join(record.archive.path, "SKILL.md"), "utf8"));
			description = typeof meta?.description === "string" ? meta.description : "";
		} catch {
			continue;
		}
		skills.push({ name, registeredName: record.registeredName, dir: record.archive.path, description });
	}
	const corpus: Doc[] = (await listSkills(curator.paths.skillsDir)).map(entry => ({
		nameTerms: new Set(tokenize(`${entry.name} ${entry.frontmatterName ?? ""}`)),
		descTerms: new Set(tokenize(entry.description ?? "")),
	}));
	const docs = skills.map(skill => ({
		skill,
		nameTerms: new Set(tokenize(`${skill.name} ${skill.registeredName ?? ""}`)),
		descTerms: new Set(tokenize(skill.description)),
	}));
	const df = new Map<string, number>();
	for (const doc of [...corpus, ...docs]) {
		for (const term of new Set([...doc.nameTerms, ...doc.descTerms])) df.set(term, (df.get(term) ?? 0) + 1);
	}
	const total = corpus.length + docs.length;
	const idf = (term: string) => Math.log(1 + total / (df.get(term) ?? 1));

	return {
		skills,
		search(query, limit = 5) {
			const terms = [...new Set(tokenize(query))];
			const hits: SearchHit[] = [];
			for (const doc of docs) {
				let score = 0;
				const matched: Array<[string, number]> = [];
				for (const term of terms) {
					const weight = doc.nameTerms.has(term) ? NAME_WEIGHT * idf(term) : doc.descTerms.has(term) ? idf(term) : 0;
					if (weight > 0) {
						score += weight;
						matched.push([term, weight]);
					}
				}
				if (score > 0) hits.push({ skill: doc.skill, score, matched: matched.sort((a, b) => b[1] - a[1]).map(([term]) => term) });
			}
			return hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)).slice(0, limit);
		},
	};
}

export interface SkillTarget {
	/** Skill name as written in the URL (store key or registered name). */
	name: string;
	/** Filesystem path to read, with the original read selector (e.g. `:10-40`) appended. */
	path: string;
}

/**
 * Map `skill://<name>[/<sub/path>][:<selector>]` (or `skill://<ns>/<name>/...`) to a file
 * inside `baseOf(name)`. Returns undefined when the URL does not name a skill `baseOf`
 * resolves, or when the subpath would escape the skill directory.
 */
export function resolveSkillUrl(url: string, baseOf: (name: string) => string | undefined): SkillTarget | undefined {
	if (!url.startsWith("skill://")) return undefined;
	const [location = "", ...selector] = url.slice("skill://".length).split(":");
	const segments = location.split("/").filter(Boolean);
	let index = 0;
	let base = segments[0] ? baseOf(segments[0]) : undefined;
	if (!base && segments[1]) {
		index = 1;
		base = baseOf(segments[1]);
	}
	if (!base) return undefined;
	const sub = segments.slice(index + 1).join("/");
	const file = normalize(join(base, sub || "SKILL.md"));
	if (file !== base && !file.startsWith(`${base}/`)) return undefined;
	return { name: segments[index]!, path: `${file}${selector.length ? `:${selector.join(":")}` : ""}` };
}

/** Archive directory of a dormant skill, by store key or registered name. */
export function dormantDir(curator: Curator, name: string): string | undefined {
	const key = curator.resolveName(name);
	const record = key ? curator.state.skills[key] : undefined;
	return record?.state === "archived" && record.archive && !record.archive.pending ? record.archive.path : undefined;
}

/** Body of a SKILL.md without its frontmatter. */
export function skillBody(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
}
