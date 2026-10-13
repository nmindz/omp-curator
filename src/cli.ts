import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Curator, assertSkillName } from "./curator.ts";
import type { Assessment, CuratorOptions, RunReport, Status } from "./curator.ts";
import { buildDormantIndex } from "./dormant.ts";
import { writeJsonAtomic } from "./fsutil.ts";
import { linkAgentsDir, unlinkAgentsDir } from "./integrations/vercel/link.ts";
import { findSources, trackSkill, updateSkills } from "./integrations/vercel/remote.ts";
import type { RemoteDeps } from "./integrations/vercel/remote.ts";
import { brokenEntries, listSkills, readSkill } from "./inventory.ts";
import { formatSearch } from "./lazy.ts";
import { withMutex } from "./mutex.ts";
import { day, table } from "./render.ts";
import { DEFAULT_CONFIG, readLedger } from "./store.ts";
import type { CuratorConfig } from "./store.ts";
import { ENCODING, openTokenizer, skillTokens } from "./tokens.ts";
import type { SkillTokens, Tokenizer } from "./tokens.ts";
import { archiveAgent, assessAgents, purgeAgent, restoreAgent, setAgentPinned, syncAgents } from "./agents.ts";

export interface CliResult {
	code: number;
	out: string;
}

export interface CliOptions extends CuratorOptions {
	remote?: RemoteDeps;
}

interface Parsed {
	positional: string[];
	flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["reason", "days", "sort", "state", "limit", "min-tokens", "max-tokens", "by"]);

function parseArgs(argv: string[]): Parsed {
	const parsed: Parsed = { positional: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) {
			parsed.positional.push(arg);
			continue;
		}
		const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
		if (inline !== undefined) parsed.flags[key] = inline;
		else if (VALUE_FLAGS.has(key) && i + 1 < argv.length) parsed.flags[key] = argv[++i]!;
		else parsed.flags[key] = true;
	}
	return parsed;
}

export const HELP = `omp-curator — usage-driven lifecycle for OMP skills, compatible with vercel-labs/skills

Setup
  init [--dry-run]            link ~/.agents/skills to the OMP store, backfill usage, seed state
  link [--dry-run] | unlink   manage the ~/.agents/skills → ~/.omp/agent/skills symlink

Usage and lifecycle
  status                      store, link, last pass, counts per state
  tokens                      prompt and SKILL.md token totals and averages per state
  list [--state S] [--json]   skills with uses, last use, idle days (S: active|stale|due|archived|all)
       [--sort KEY[:asc|:desc][,KEY…]]
                              sort by one or more columns, in order: skill|state|uses|last-used|idle|
                              harnesses|prompt-tok|skillmd-tok|notes; missing values sort lowest
                              (default state,idle). --asc/--desc set keys without a direction.
       [--asc | --desc]
       [--tokenize]           add exact token counts (o200k_base): prompt entry and full SKILL.md
       [--min-tokens N] [--max-tokens N] [--by prompt|body]
                              keep skills within a token range (implies --tokenize; --by picks
                              the count filtered on, default prompt)
  show <skill>                usage evidence for one skill
  scan                        pull new usage evidence from session histories
  run [--dry-run]             scan, promote re-used dormant skills, relabel stale ones, archive due ones
  search <query...>           find dormant (archived) skills by task keywords
  archive <skill...> [--reason TEXT]
                              make skills dormant: out of the prompt, still lazy-loaded on demand
  restore <skill...>          move archived skills back (re-adds their \`skills\` lock entries)
  pin <skill...> | unpin <skill...>
  prune [--days N] [--dry-run]   archive every unprotected skill idle for N days (default archiveAfterDays)
  purge <skill...>            permanently delete archived copies
  ledger [--limit N]          recent lifecycle changes

vercel-labs/skills
  update [skill...] [--dry-run]  update GitHub-tracked skills into the OMP store only (-a pi)
  track <skill> <source>         reinstall a store skill from <source> so \`skills\` tracks it (backs up first)
  sources <skill>                find published sources for a skill on skills.sh

Agents (~/.omp/agent/agents/*.md; usage = subagent spawns in OMP and Claude Code history)
  agents [list] [--state S] [--json]   agents with spawns, last spawn, idle days, autoloaded skills
  agents archive <agent...> [--reason TEXT]   move definitions to the archive (OMP stops offering them)
  agents restore <agent...> | agents pin|unpin <agent...> | agents purge <agent...>

Maintenance
  doctor [--fix]              link state, stray harness symlinks, lock drift, invalid SKILL.md files
  config [key [value]]        show or set config (JSON values)
`;

type TokenMap = Map<string, SkillTokens>;

const harnessText = (item: Assessment): string =>
	Object.entries(item.usage?.byHarness ?? {})
		.map(([harness, count]) => `${harness}:${count}`)
		.join(" ") || "-";
const notesText = (item: Assessment): string => [item.protectedBy, item.origin].filter(Boolean).join("; ");

interface Column {
	/** `--sort` key. */
	key: string;
	header: string;
	align: "left" | "right";
	/** Needs token counts (`--tokenize`). */
	tokens?: boolean;
	cell(item: Assessment, tokens?: TokenMap): string;
	/** Ascending order; ties fall back to the skill name. */
	compare(a: Assessment, b: Assessment, tokens?: TokenMap): number;
	/** Direction used without `--asc`/`--desc`: the most telling end first. */
	desc: boolean;
}

const STATE_RANK: Record<Status, number> = { due: 0, stale: 1, active: 2, archived: 3 };
// A skill without counts (no SKILL.md) sorts below any counted one, like other missing values.
const tokenValue = (tokens: TokenMap | undefined, item: Assessment, measure: keyof SkillTokens) => tokens?.get(item.name)?.[measure] ?? -1;

export const LIST_COLUMNS: readonly Column[] = [
	{ key: "skill", header: "skill", align: "left", desc: false, cell: item => item.name, compare: (a, b) => a.name.localeCompare(b.name) },
	{ key: "state", header: "state", align: "left", desc: false, cell: item => item.status, compare: (a, b) => STATE_RANK[a.status] - STATE_RANK[b.status] },
	{ key: "uses", header: "uses", align: "right", desc: true, cell: item => String(item.usage?.uses ?? 0), compare: (a, b) => (a.usage?.uses ?? 0) - (b.usage?.uses ?? 0) },
	{
		key: "last-used",
		header: "last used",
		align: "left",
		desc: true,
		cell: item => day(item.usage?.lastUsed),
		compare: (a, b) => (a.usage?.lastUsed ?? "").localeCompare(b.usage?.lastUsed ?? ""),
	},
	{ key: "idle", header: "idle", align: "right", desc: true, cell: item => String(item.idleDays), compare: (a, b) => a.idleDays - b.idleDays },
	{ key: "harnesses", header: "harnesses", align: "left", desc: false, cell: harnessText, compare: (a, b) => harnessText(a).localeCompare(harnessText(b)) },
	{
		key: "prompt-tok",
		header: "prompt tok",
		align: "right",
		desc: true,
		tokens: true,
		cell: (item, tokens) => String(tokens?.get(item.name)?.prompt ?? "-"),
		compare: (a, b, tokens) => tokenValue(tokens, a, "prompt") - tokenValue(tokens, b, "prompt"),
	},
	{
		key: "skillmd-tok",
		header: "SKILL.md tok",
		align: "right",
		desc: true,
		tokens: true,
		cell: (item, tokens) => String(tokens?.get(item.name)?.body ?? "-"),
		compare: (a, b, tokens) => tokenValue(tokens, a, "body") - tokenValue(tokens, b, "body"),
	},
	{ key: "notes", header: "notes", align: "left", desc: false, cell: notesText, compare: (a, b) => notesText(a).localeCompare(notesText(b)) },
];

export interface SortKey {
	column: Column;
	descending: boolean;
}

/** Default order: by state, the longest idle first within each. */
const DEFAULT_SORT = "state,idle";

/**
 * Parse `key[:asc|:desc][,key[:asc|:desc]…]`. Keys apply in order, each breaking the ties of
 * the previous one. A key without a direction takes `fallback` (from `--asc`/`--desc`) or its
 * column's default.
 */
export function parseSort(spec: string, fallback?: "asc" | "desc"): SortKey[] {
	return spec.split(",").map(part => {
		const [key = "", direction, ...extra] = part.trim().split(":");
		const column = LIST_COLUMNS.find(candidate => candidate.key === key);
		if (!column) throw new Error(`unknown sort key "${key}" (${LIST_COLUMNS.map(candidate => candidate.key).join("|")})`);
		if (extra.length || (direction !== undefined && direction !== "asc" && direction !== "desc")) {
			throw new Error(`invalid sort direction in "${part.trim()}" (use ${key}:asc or ${key}:desc)`);
		}
		const chosen = direction ?? fallback;
		return { column, descending: chosen ? chosen === "desc" : column.desc };
	});
}

/** Missing values (no last use, no token count, no notes) compare as the lowest. Final ties: skill name. */
function sortItems(items: Assessment[], keys: SortKey[], tokens?: TokenMap): Assessment[] {
	return [...items].sort((a, b) => {
		for (const { column, descending } of keys) {
			const order = column.compare(a, b, tokens);
			if (order) return descending ? -order : order;
		}
		return a.name.localeCompare(b.name);
	});
}

function renderList(items: Assessment[], tokens?: TokenMap): string {
	const columns = LIST_COLUMNS.filter(column => !column.tokens || tokens);
	return table(
		columns.map(column => column.header),
		items.map(item => columns.map(column => column.cell(item, tokens))),
		columns.map(column => column.align),
	);
}

/** Exact token counts for each skill, read from the store or, for dormant skills, the archive. */
async function tokenize(curator: Curator, items: Assessment[]): Promise<{ tokenizer: Tokenizer; tokens: TokenMap }> {
	const tokenizer = await openTokenizer(curator.paths);
	const tokens: TokenMap = new Map();
	for (const item of items) {
		const dir = item.entry?.path ?? item.record.archive?.path;
		if (!dir) continue;
		const entry = item.entry ?? (await readSkill(dir, item.name));
		const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => "");
		tokens.set(item.name, skillTokens(tokenizer, entry?.frontmatterName ?? item.name, entry?.description, entry?.hidden ?? false, text));
	}
	return { tokenizer, tokens };
}

function sumTokens(items: Assessment[], tokens: TokenMap, measure: TokenMeasure): number {
	return items.reduce((total, item) => total + (tokens.get(item.name)?.[measure] ?? 0), 0);
}

function tokenSummary(items: Assessment[], tokens: TokenMap, tokenizer: Tokenizer): string {
	const avg = (total: number) => (items.length ? Math.round(total / items.length) : 0);
	const prompt = sumTokens(items, tokens, "prompt");
	const body = sumTokens(items, tokens, "body");
	return [
		`${items.length} skill(s) · prompt ${prompt} tokens (avg ${avg(prompt)}) · SKILL.md ${body} tokens (avg ${avg(body)})${tokenizer.exact ? "" : " · estimated"}`,
		...(tokenizer.warning ? [`warn ${tokenizer.warning}`] : []),
	].join("\n");
}

async function cmdTokens(curator: Curator): Promise<string> {
	const items = await curator.assess();
	const { tokenizer, tokens } = await tokenize(curator, items);
	const states: Status[] = ["active", "stale", "due", "archived"];
	const rows = states.map(state => {
		const group = items.filter(item => item.status === state);
		const prompt = sumTokens(group, tokens, "prompt");
		const body = sumTokens(group, tokens, "body");
		const avg = (total: number) => String(group.length ? Math.round(total / group.length) : 0);
		return [state === "archived" ? "dormant (archived)" : state, String(group.length), String(prompt), avg(prompt), String(body), avg(body)];
	});
	const listed = items.filter(item => item.status !== "archived");
	return [
		table(["state", "skills", "prompt tok", "avg", "SKILL.md tok", "avg"], rows, ["left", "right", "right", "right", "right", "right"]),
		"",
		`in every session's system prompt now: ${sumTokens(listed, tokens, "prompt")} tokens (${listed.length} listed skills; dormant ones cost 0 until loaded)`,
		`counted with ${ENCODING}${tokenizer.exact ? "" : " estimates"}; prompt tok = the skill's "- name: description" entry, SKILL.md tok = the full file loaded on use`,
		...(tokenizer.warning ? [`warn ${tokenizer.warning}`] : []),
	].join("\n");
}

function renderRun(report: RunReport): string {
	const scan = Object.entries(report.scan);
	const lines = [
		`scan: ${scan
			.map(([id, result]) => (result.missing ? `${id} not installed` : result.error ? `${id} unreadable` : `${id} +${result.added} events (${result.files} files)`))
			.join(", ")}`,
	];
	for (const [id, result] of scan) {
		if (result.error) lines.push(`warn ${id}: ${result.error}; its earlier usage is kept, new usage from it is not counted until it is readable`);
	}
	const fresh = report.transitions.filter(t => t.from === "new");
	const changes = report.transitions.filter(t => t.from !== "new");
	if (fresh.length) lines.push(`${report.dryRun ? "would track" : "tracking"} ${fresh.length} newly seen skill(s)`);
	if (changes.length === 0) lines.push("no state changes");
	for (const t of changes) lines.push(`${report.dryRun ? "would " : ""}${t.name}: ${t.from} → ${t.to}${t.detail ? ` (${t.detail})` : ""}`);
	return lines.join("\n");
}

async function cmdStatus(curator: Curator): Promise<string> {
	const items = await curator.assess();
	const counts: Record<string, number> = {};
	for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
	const next = curator.state.lastRunAt
		? new Date(new Date(curator.state.lastRunAt).getTime() + curator.config.intervalHours * 3_600_000).toISOString()
		: undefined;
	const idle = items.filter(item => item.status !== "archived").sort((a, b) => b.idleDays - a.idleDays).slice(0, 5);
	const doctor = await Promise.all(curator.integrations.map(integration => integration.doctor?.(curator.integrationContext) ?? []));
	const link = doctor.flat().find(finding => finding.message.includes(curator.paths.agentsSkillsDir));
	return [
		`store:      ${curator.paths.skillsDir}`,
		`link:       ${link ? `${link.level === "ok" ? "" : "⚠ "}${link.message}` : "-"}`,
		`skills:     ${["active", "stale", "due", "archived"].map(status => `${status === "archived" ? "dormant (archived)" : status} ${counts[status] ?? 0}`).join(" · ")}`,
		`last pass:  ${curator.state.lastRunAt ?? "never (run `omp-curator init`)"}${next ? ` · next automatic pass ≥ ${next}` : ""}`,
		`policy:     stale after ${curator.config.staleAfterDays}d · archive after ${curator.config.archiveAfterDays}d · autoArchive ${curator.config.autoArchive}`,
		`usage:      ${curator.usage.events.length} events from ${Object.keys(curator.usage.cursors).length} sources`,
		"",
		"longest idle:",
		...idle.map(item => `  ${item.name} — ${item.idleDays}d idle, ${item.usage?.uses ?? 0} uses${item.protectedBy ? ` (${item.protectedBy})` : ""}`),
	].join("\n");
}

type Mutate = <T>(fn: () => Promise<T>) => Promise<T>;

async function cmdAgents(curator: Curator, args: string[], flags: Parsed["flags"], mutate: Mutate): Promise<CliResult> {
	const [sub = "list", ...names] = args;
	const each = (fn: (name: string) => Promise<string>) =>
		mutate(async () => {
			if (!names.length) throw new Error(`usage: omp-curator agents ${sub} <agent...>`);
			const lines: string[] = [];
			for (const name of names) lines.push(await fn(name));
			return { code: 0, out: lines.join("\n") };
		});
	switch (sub) {
		case "list": {
			// Record definitions added since the last pass so they show up without one.
			await syncAgents(curator, "user", true);
			const state = typeof flags.state === "string" ? flags.state : "all";
			const rank: Record<Status, number> = { due: 0, stale: 1, active: 2, archived: 3 };
			const items = (await assessAgents(curator))
				.filter(item => state === "all" || item.status === state)
				.sort((a, b) => rank[a.status] - rank[b.status] || b.idleDays - a.idleDays || a.name.localeCompare(b.name));
			if (flags.json) {
				return { code: 0, out: JSON.stringify(items.map(({ entry, record, ...rest }) => ({ ...rest, path: record.archive?.path ?? entry?.path, autoloadSkills: entry?.autoloadSkills ?? [] })), null, 2) };
			}
			if (!items.length) return { code: 0, out: "no agents match" };
			const rows = items.map(item => [
				item.name,
				item.status,
				String(item.usage?.spawns ?? 0),
				day(item.usage?.lastSpawned),
				String(item.idleDays),
				Object.entries(item.usage?.byHarness ?? {})
					.map(([harness, count]) => `${harness}:${count}`)
					.join(" ") || "-",
				item.entry?.autoloadSkills.join(", ") || "-",
				item.pinned ? "pinned" : "",
			]);
			return {
				code: 0,
				out: table(["agent", "state", "spawns", "last spawn", "idle", "harnesses", "autoloads", "notes"], rows, ["left", "left", "right", "left", "right", "left", "left"]),
			};
		}
		case "archive": {
			const reason = typeof flags.reason === "string" ? flags.reason : "manual";
			return each(async name => `archived agent ${name} → ${await archiveAgent(curator, name, reason, "user")}`);
		}
		case "restore":
			return each(async name => `restored agent ${name} → ${await restoreAgent(curator, name, "user")}`);
		case "pin":
		case "unpin":
			return each(async name => {
				await setAgentPinned(curator, name, sub === "pin", "user");
				return `${sub === "pin" ? "pinned" : "unpinned"} agent ${name}`;
			});
		case "purge":
			return each(async name => `deleted ${await purgeAgent(curator, name, "user")}`);
		default:
			throw new Error(`unknown agents command "${sub}" (list|archive|restore|pin|unpin|purge)`);
	}
}

async function cmdShow(curator: Curator, name: string): Promise<string> {
	const item = (await curator.assess()).find(entry => entry.name === name);
	if (!item) throw new Error(`unknown skill "${name}"`);
	const events = curator.usage.events.filter(event => event.skill === name).sort((a, b) => b.at.localeCompare(a.at));
	return [
		`${name}: ${item.status}${item.pinned ? " (pinned)" : ""}${item.protectedBy && !item.pinned ? ` (${item.protectedBy})` : ""}`,
		`path:        ${item.record.archive?.path ?? item.entry?.path ?? "-"}`,
		`origin:      ${item.origin ?? "native"}`,
		`first seen:  ${day(item.record.firstSeen)} · idle since ${day(item.idleSince)} (${item.idleDays}d)`,
		`uses:        ${item.usage?.uses ?? 0} · last ${day(item.usage?.lastUsed)} · mentions ${item.usage?.mentions ?? 0}`,
		`by kind:     ${JSON.stringify(item.usage?.byKind ?? {})}`,
		...(item.entry?.problems.length ? [`problems:    ${item.entry.problems.join("; ")}`] : []),
		"",
		"recent evidence:",
		...events.slice(0, 15).map(event => `  ${event.at.slice(0, 16).replace("T", " ")}  ${event.harness.padEnd(8)} ${event.kind.padEnd(10)} ${event.src.replace(/^[^:]+:/, "").replace(curator.paths.home, "~")}`),
	].join("\n");
}

async function cmdDoctor(curator: Curator, fix: boolean): Promise<string> {
	const lines: string[] = [];
	for (const integration of curator.integrations) {
		for (const finding of (await integration.doctor?.(curator.integrationContext)) ?? []) {
			lines.push(`${finding.level === "ok" ? "ok  " : finding.level === "warn" ? "warn" : "err "} ${finding.message}${finding.fix ? `  → ${finding.fix}` : ""}`);
		}
		if (fix) for (const change of (await integration.fix?.(curator.integrationContext)) ?? []) lines.push(`fixed ${change}`);
	}
	for (const broken of await brokenEntries(curator.paths.skillsDir)) {
		lines.push(`warn ${broken.name}: ${broken.reason}; OMP cannot load it  → rm ${join(curator.paths.skillsDir, broken.name)}`);
	}
	for (const entry of await listSkills(curator.paths.skillsDir)) {
		for (const problem of entry.problems) lines.push(`warn ${entry.name}: ${problem}`);
	}
	return lines.join("\n") || "no findings";
}

function cmdConfig(config: CuratorConfig, key?: string, value?: string): { config?: CuratorConfig; out: string } {
	if (!key) return { out: JSON.stringify(config, null, 2) };
	if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`unknown config key "${key}" (${Object.keys(DEFAULT_CONFIG).join(", ")})`);
	const typedKey = key as keyof CuratorConfig;
	if (value === undefined) return { out: JSON.stringify(config[typedKey], null, 2) };
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = value;
	}
	if (typeof parsed !== typeof DEFAULT_CONFIG[typedKey] || Array.isArray(parsed) !== Array.isArray(DEFAULT_CONFIG[typedKey])) {
		throw new Error(`"${key}" expects ${Array.isArray(DEFAULT_CONFIG[typedKey]) ? "an array" : typeof DEFAULT_CONFIG[typedKey]}`);
	}
	return { config: { ...config, [typedKey]: parsed }, out: `${key} = ${JSON.stringify(parsed)}` };
}

/** Run one CLI invocation and return its output instead of printing (the extension reuses it). */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
	const { positional, flags } = parseArgs(argv);
	const [command = "help", ...args] = positional;
	const dryRun = flags["dry-run"] === true;
	const curator = await Curator.open(options);
	const mutate = <T>(fn: () => Promise<T>) => withMutex(curator.paths, async () => {
		await curator.reload();
		return fn();
	});
	const requireArgs = (min: number, usage: string) => {
		if (args.length < min) throw new Error(`usage: omp-curator ${usage}`);
	};

	switch (command) {
		case "help":
		case "--help":
			return { code: 0, out: HELP };
		case "init":
			return mutate(async () => {
				const link = await linkAgentsDir(curator.paths, dryRun);
				// Adopt the existing library (idle from real history); label but never archive here.
				// The next automatic pass is one interval away.
				const report = await curator.run("user", { dryRun, allowArchive: false, adopt: true });
				if (!dryRun) {
					curator.state.initializedAt ??= curator.now.toISOString();
					await curator.save();
				}
				const lines = [
					`link: ${link.before === "linked" ? "already linked" : `${dryRun ? "would link" : "linked"} ${curator.paths.agentsSkillsDir} → ${curator.paths.skillsDir}`}`,
					...link.moved.map(name => `  moved ${name} into the store`),
					...link.duplicates.map(name => `  dropped duplicate ${name}`),
					...link.conflicts.map(conflict => `  conflict ${conflict.name}: kept the store copy, parked the other at ${conflict.keptAt}`),
					renderRun(report),
				];
				return { code: 0, out: lines.join("\n") };
			});
		case "link":
			return mutate(async () => {
				const link = await linkAgentsDir(curator.paths, dryRun);
				return { code: 0, out: link.before === "linked" ? "already linked" : JSON.stringify(link, null, 2) };
			});
		case "unlink":
			return mutate(async () => {
				await unlinkAgentsDir(curator.paths);
				return { code: 0, out: `${curator.paths.agentsSkillsDir} is an empty directory again; the OMP store is unchanged` };
			});
		case "scan":
			return mutate(async () => {
				const scan = await curator.scan();
				await curator.save();
				return { code: 0, out: renderRun({ scan, transitions: [], dryRun: false }) };
			});
		case "run":
			return mutate(async () => ({ code: 0, out: renderRun(await curator.run("user", { dryRun })) }));
		case "status":
			return { code: 0, out: await cmdStatus(curator) };
		case "tokens":
			return { code: 0, out: await cmdTokens(curator) };
		case "list": {
			const state = typeof flags.state === "string" ? flags.state : "all";
			if (flags.asc && flags.desc) throw new Error("use either --asc or --desc");
			const keys = parseSort(typeof flags.sort === "string" ? flags.sort : DEFAULT_SORT, flags.asc ? "asc" : flags.desc ? "desc" : undefined);
			const bound = (flag: string) => {
				const raw = flags[flag];
				if (raw === undefined) return undefined;
				const value = Number(raw);
				if (typeof raw !== "string" || !Number.isFinite(value) || value < 0) throw new Error(`--${flag} expects a non-negative number`);
				return value;
			};
			const min = bound("min-tokens");
			const max = bound("max-tokens");
			const measure = flags.by ?? "prompt";
			if (measure !== "prompt" && measure !== "body") throw new Error(`--by expects prompt or body`);
			let items = (await curator.assess()).filter(item => state === "all" || item.status === state);
			// Token filters and token columns need counts, so they imply --tokenize.
			const counted =
				flags.tokenize || min !== undefined || max !== undefined || keys.some(key => key.column.tokens) ? await tokenize(curator, items) : undefined;
			if (counted) {
				items = items.filter(item => {
					const value = counted.tokens.get(item.name)?.[measure] ?? 0;
					return (min === undefined || value >= min) && (max === undefined || value <= max);
				});
			}
			items = sortItems(items, keys, counted?.tokens);
			if (flags.json) {
				const rows = items.map(({ entry, record, ...rest }) => ({ ...rest, path: record.archive?.path ?? entry?.path, ...(counted ? { tokens: counted.tokens.get(rest.name) } : {}) }));
				return { code: 0, out: JSON.stringify(rows, null, 2) };
			}
			if (!items.length) return { code: 0, out: "no skills match" };
			const out = renderList(items, counted?.tokens);
			return { code: 0, out: counted ? `${out}\n\n${tokenSummary(items, counted.tokens, counted.tokenizer)}` : out };
		}
		case "show":
			requireArgs(1, "show <skill>");
			return { code: 0, out: await cmdShow(curator, args[0]!) };
		case "archive":
			requireArgs(1, "archive <skill...> [--reason TEXT]");
			return mutate(async () => {
				const reason = typeof flags.reason === "string" ? flags.reason : "manual";
				const lines: string[] = [];
				for (const name of args) lines.push(`archived ${name} → ${await curator.archive(name, reason, "user")}`);
				return { code: 0, out: lines.join("\n") };
			});
		case "restore":
			requireArgs(1, "restore <skill...>");
			return mutate(async () => {
				const lines: string[] = [];
				for (const name of args) lines.push(`restored ${name} → ${await curator.restore(name, "user")} (listed in new OMP sessions)`);
				return { code: 0, out: lines.join("\n") };
			});
		case "agents":
			return cmdAgents(curator, args, flags, mutate);
		case "pin":
		case "unpin":
			requireArgs(1, `${command} <skill...>`);
			return mutate(async () => {
				for (const name of args) await curator.setPinned(name, command === "pin", "user");
				return { code: 0, out: `${command === "pin" ? "pinned" : "unpinned"} ${args.join(", ")}` };
			});
		case "prune":
			return mutate(async () => {
				const days = typeof flags.days === "string" ? Number(flags.days) : curator.config.archiveAfterDays;
				if (!Number.isFinite(days) || days < 0) throw new Error("--days expects a non-negative number");
				// Fresh evidence first: the persisted usage can be an interval old.
				await curator.run("user", { dryRun, allowArchive: false });
				const due = (await curator.assess()).filter(item => item.status !== "archived" && !item.protectedBy && item.idleDays >= days);
				const lines: string[] = [];
				for (const item of due) {
					if (dryRun) lines.push(`would archive ${item.name} (idle ${item.idleDays}d)`);
					else lines.push(`archived ${item.name} → ${await curator.archive(item.name, `prune: idle ${item.idleDays} days`, "user")}`);
				}
				return { code: 0, out: lines.join("\n") || `nothing idle for ${days}+ days` };
			});
		case "purge":
			requireArgs(1, "purge <skill...>");
			return mutate(async () => {
				const lines: string[] = [];
				for (const name of args) lines.push(`deleted ${await curator.purge(name, "user")}`);
				return { code: 0, out: lines.join("\n") };
			});
		case "ledger": {
			const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
			const entries = await readLedger(curator.paths, limit);
			return {
				code: 0,
				out: entries.map(entry => `${entry.at.slice(0, 19).replace("T", " ")}  ${entry.actor.padEnd(9)} ${entry.action.padEnd(10)} ${entry.skill ?? ""}${entry.detail ? `  ${entry.detail}` : ""}`).join("\n") || "ledger is empty",
			};
		}
		case "update":
			return mutate(async () => {
				const active = new Set((await listSkills(curator.paths.skillsDir)).map(entry => entry.name));
				const items = await updateSkills(curator.paths, curator.config.skillsCommand, { names: args, dryRun, active }, options.remote);
				if (!dryRun && items.some(item => item.status === "updated")) await curator.sync("user");
				if (!dryRun) await curator.save();
				return {
					code: items.some(item => item.status === "failed") ? 1 : 0,
					out: items.map(item => `${item.status.padEnd(8)} ${item.name}${item.detail ? `  ${item.detail}` : ""}`).join("\n") || "no skills tracked in the skills lock",
				};
			});
		case "track":
			requireArgs(2, "track <skill> <source>");
			assertSkillName(args[0]!);
			return mutate(async () => {
				const result = await trackSkill(curator.paths, curator.config.skillsCommand, args[0]!, args[1]!, options.remote);
				await curator.sync("user");
				await curator.ledger("user", "track", args[0], args[1]);
				await curator.save();
				return { code: 0, out: `${args[0]} now tracked from ${args[1]}${result.backup ? `; previous copy backed up at ${result.backup}` : ""}` };
			});
		case "search": {
			requireArgs(1, "search <query...>");
			return { code: 0, out: formatSearch(await buildDormantIndex(curator), args.join(" "), 20, true) };
		}
		case "sources": {
			requireArgs(1, "sources <skill>");
			const candidates = await findSources(args[0]!);
			if (!candidates.length) return { code: 0, out: `no published skill named "${args[0]}" on skills.sh` };
			return {
				code: 0,
				out: table(
					["source", "installs", "track with"],
					candidates.map(candidate => [candidate.source, String(candidate.installs), `omp-curator track ${args[0]} ${candidate.source}`]),
					["left", "right"],
				),
			};
		}
		case "doctor":
			return mutate(async () => ({ code: 0, out: await cmdDoctor(curator, flags.fix === true) }));
		case "config":
			return mutate(async () => {
				const result = cmdConfig(curator.config, args[0], args[1]);
				if (result.config) await writeJsonAtomic(curator.paths.configPath, result.config);
				return { code: 0, out: result.out };
			});
		default:
			return { code: 2, out: `unknown command "${command}"\n\n${HELP}` };
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	try {
		const result = await runCli(argv);
		if (result.out) (result.code === 0 ? process.stdout : process.stderr).write(`${result.out}\n`);
		process.exitCode = result.code;
	} catch (error) {
		process.stderr.write(`omp-curator: ${(error as Error).message}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
