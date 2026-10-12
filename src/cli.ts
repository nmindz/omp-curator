import { join } from "node:path";
import { Curator, assertSkillName } from "./curator.ts";
import type { Assessment, CuratorOptions, RunReport, Status } from "./curator.ts";
import { buildDormantIndex } from "./dormant.ts";
import { writeJsonAtomic } from "./fsutil.ts";
import { linkAgentsDir, unlinkAgentsDir } from "./integrations/vercel/link.ts";
import { findSources, trackSkill, updateSkills } from "./integrations/vercel/remote.ts";
import type { RemoteDeps } from "./integrations/vercel/remote.ts";
import { brokenEntries, listSkills } from "./inventory.ts";
import { formatSearch } from "./lazy.ts";
import { withMutex } from "./mutex.ts";
import { day, table } from "./render.ts";
import { DEFAULT_CONFIG, readLedger } from "./store.ts";
import type { CuratorConfig } from "./store.ts";

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

const VALUE_FLAGS = new Set(["reason", "days", "sort", "state", "limit"]);

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
  list [--state S] [--sort K] skills with uses, last use, idle days (S: active|stale|due|archived|all;
       [--json]               K: name|uses|idle|last|tokens)
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

Maintenance
  doctor [--fix]              link state, stray harness symlinks, lock drift, invalid SKILL.md files
  config [key [value]]        show or set config (JSON values)
`;

function sortItems(items: Assessment[], key: string): Assessment[] {
	const rank: Record<Status, number> = { due: 0, stale: 1, active: 2, archived: 3 };
	const by: Record<string, (a: Assessment, b: Assessment) => number> = {
		name: (a, b) => a.name.localeCompare(b.name),
		uses: (a, b) => (b.usage?.uses ?? 0) - (a.usage?.uses ?? 0) || a.name.localeCompare(b.name),
		idle: (a, b) => b.idleDays - a.idleDays || a.name.localeCompare(b.name),
		last: (a, b) => (b.usage?.lastUsed ?? "").localeCompare(a.usage?.lastUsed ?? "") || a.name.localeCompare(b.name),
		tokens: (a, b) => (b.entry?.descriptionTokens ?? 0) - (a.entry?.descriptionTokens ?? 0),
		state: (a, b) => rank[a.status] - rank[b.status] || b.idleDays - a.idleDays || a.name.localeCompare(b.name),
	};
	const compare = by[key];
	if (!compare) throw new Error(`unknown sort key "${key}" (name|uses|idle|last|tokens|state)`);
	return [...items].sort(compare);
}

function renderList(items: Assessment[]): string {
	const rows = items.map(item => [
		item.name,
		item.status,
		String(item.usage?.uses ?? 0),
		day(item.usage?.lastUsed),
		String(item.idleDays),
		Object.entries(item.usage?.byHarness ?? {})
			.map(([harness, count]) => `${harness}:${count}`)
			.join(" ") || "-",
		String(item.entry?.descriptionTokens ?? "-"),
		[item.protectedBy, item.origin].filter(Boolean).join("; "),
	]);
	return table(["skill", "state", "uses", "last used", "idle", "harnesses", "tok", "notes"], rows, [
		"left",
		"left",
		"right",
		"left",
		"right",
		"left",
		"right",
	]);
}

function renderRun(report: RunReport): string {
	const lines = [
		`scan: ${Object.entries(report.scan)
			.map(([id, result]) => `${id} +${result.added} events (${result.files} files)`)
			.join(", ")}`,
	];
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
		case "list": {
			const state = typeof flags.state === "string" ? flags.state : "all";
			const items = sortItems(
				(await curator.assess()).filter(item => state === "all" || item.status === state),
				typeof flags.sort === "string" ? flags.sort : "state",
			);
			if (flags.json) {
				const rows = items.map(({ entry, record, ...rest }) => ({ ...rest, path: record.archive?.path ?? entry?.path, tokens: entry?.descriptionTokens }));
				return { code: 0, out: JSON.stringify(rows, null, 2) };
			}
			return { code: 0, out: items.length ? renderList(items) : "no skills match" };
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
