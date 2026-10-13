import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Actor, Curator, Status, Transition } from "./curator.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { daysBetween, exists, moveEntry, stamp } from "./fsutil.ts";
import { autoloadList } from "./inventory.ts";
import type { AgentRecord } from "./store.ts";
import type { AgentSpawn } from "./usage/types.ts";

/** An agent definition in `~/.omp/agent/agents/<name>.md`. */
export interface AgentEntry {
	name: string;
	path: string;
	description?: string;
	autoloadSkills: string[];
	createdAt: Date;
}

export interface AgentUsage {
	spawns: number;
	firstSpawned?: string;
	lastSpawned?: string;
	byHarness: Record<string, number>;
}

export interface AgentAssessment {
	name: string;
	status: Status;
	idleDays: number;
	idleSince: string;
	usage?: AgentUsage;
	pinned: boolean;
	protectedBy?: string;
	entry?: AgentEntry;
	record: AgentRecord;
}

/** Agent names become file names; reject anything that could escape the agents directory. */
export function assertAgentName(name: string): void {
	if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error(`invalid agent name "${name}"`);
}

export async function readAgent(path: string, name: string): Promise<AgentEntry | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const meta = parseFrontmatter(text);
	const info = await lstat(path);
	return {
		name,
		path,
		description: typeof meta?.description === "string" ? meta.description : undefined,
		autoloadSkills: autoloadList(meta),
		createdAt: new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs),
	};
}

export async function listAgents(dir: string): Promise<AgentEntry[]> {
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}
	const entries: AgentEntry[] = [];
	for (const file of files.filter(name => name.endsWith(".md")).sort()) {
		const entry = await readAgent(join(dir, file), file.slice(0, -3));
		if (entry) entries.push(entry);
	}
	return entries;
}

export function aggregateSpawns(spawns: AgentSpawn[] = []): Map<string, AgentUsage> {
	const out = new Map<string, AgentUsage>();
	for (const spawn of spawns) {
		let usage = out.get(spawn.agent);
		if (!usage) {
			usage = { spawns: 0, byHarness: {} };
			out.set(spawn.agent, usage);
		}
		usage.spawns++;
		usage.byHarness[spawn.harness] = (usage.byHarness[spawn.harness] ?? 0) + 1;
		if (!usage.lastSpawned || spawn.at > usage.lastSpawned) usage.lastSpawned = spawn.at;
		if (!usage.firstSpawned || spawn.at < usage.firstSpawned) usage.firstSpawned = spawn.at;
	}
	return out;
}

const label = (name: string) => `agent:${name}`;

/**
 * Reconcile agent records with the agents directory: record new definitions, finish or roll
 * back an interrupted archive, and forget definitions removed outside omp-curator.
 *
 * A new definition whose spawns predate its file was migrated, not created, so its idle time
 * counts from its first spawn rather than from the file's creation.
 */
export async function syncAgents(curator: Curator, actor: Actor, dryRun: boolean): Promise<Transition[]> {
	const now = curator.now.toISOString();
	const records = curator.state.agents;
	const entries = new Map((await listAgents(curator.paths.agentDefsDir)).map(entry => [entry.name, entry]));
	const usage = aggregateSpawns(curator.usage.spawns);
	const transitions: Transition[] = [];

	for (const [name, record] of Object.entries(records)) {
		if (!record.archive?.pending) continue;
		if ((await exists(record.archive.path)) && !entries.has(name)) {
			record.state = "archived";
			record.stateSince = now;
			delete record.archive.pending;
			transitions.push({ name: label(name), from: "active", to: "archived", detail: "completed an interrupted archive" });
		} else {
			delete record.archive;
			transitions.push({ name: label(name), from: "active", to: "active", detail: "rolled back an interrupted archive" });
		}
	}

	for (const entry of entries.values()) {
		const record = Object.hasOwn(records, entry.name) ? records[entry.name] : undefined;
		if (!record) {
			const first = usage.get(entry.name)?.firstSpawned;
			const created = entry.createdAt.toISOString();
			records[entry.name] = { firstSeen: now, floorAt: first && first < created ? first : created, state: "active", stateSince: now };
			transitions.push({ name: label(entry.name), from: "new", to: "active" });
		} else if (record.state === "archived") {
			// Recreated while archived (by hand or an installer): it is in use again.
			transitions.push({ name: label(entry.name), from: "archived", to: "active", detail: "recreated while archived" });
			if (!dryRun) await curator.ledger(actor, "agent-reinstalled", entry.name);
			Object.assign(record, { state: "active", stateSince: now, floorAt: now });
			delete record.archive;
		}
	}

	for (const [name, record] of Object.entries(records)) {
		if (record.state === "archived" || entries.has(name)) continue;
		transitions.push({ name: label(name), from: "missing", to: "removed", detail: "removed outside omp-curator" });
		if (!dryRun) await curator.ledger(actor, "agent-forgotten", name, "definition missing");
		delete records[name];
	}
	return transitions;
}

export async function assessAgents(curator: Curator): Promise<AgentAssessment[]> {
	const entries = new Map((await listAgents(curator.paths.agentDefsDir)).map(entry => [entry.name, entry]));
	const usage = aggregateSpawns(curator.usage.spawns);
	const now = curator.now;
	return Object.entries(curator.state.agents).map(([name, record]) => {
		const stats = usage.get(name);
		const idleSince = stats?.lastSpawned && stats.lastSpawned > record.floorAt ? stats.lastSpawned : record.floorAt;
		const idleDays = Math.max(0, daysBetween(idleSince, now));
		const pinned = record.pinned === true;
		let status: Status = "active";
		if (record.state === "archived") status = "archived";
		else if (idleDays >= curator.config.archiveAfterDays && !pinned) status = "due";
		else if (idleDays >= curator.config.staleAfterDays) status = "stale";
		return { name, status, idleDays, idleSince, usage: stats, pinned, protectedBy: pinned ? "pinned" : undefined, entry: entries.get(name), record };
	});
}

/** Relabel agents and, when allowed, archive the due ones. Part of every pass. */
export async function passAgents(curator: Curator, actor: Actor, dryRun: boolean, allowArchive: boolean): Promise<Transition[]> {
	const transitions = await syncAgents(curator, actor, dryRun);
	const now = curator.now.toISOString();
	for (const item of await assessAgents(curator)) {
		if (item.status === "archived") continue;
		if (item.status === "due" && allowArchive) {
			transitions.push({ name: label(item.name), from: item.record.state, to: "archived", detail: `idle ${item.idleDays}d` });
			if (!dryRun) await archiveAgent(curator, item.name, `idle ${item.idleDays} days`, actor);
			continue;
		}
		const next = item.status === "due" ? "stale" : item.status;
		if (next === item.record.state) continue;
		transitions.push({ name: label(item.name), from: item.record.state, to: next, detail: `idle ${item.idleDays}d` });
		item.record.state = next;
		item.record.stateSince = now;
		if (!dryRun) await curator.ledger(actor, `agent-${next}`, item.name, `idle ${item.idleDays}d`);
	}
	return transitions;
}

function agentRecord(curator: Curator, name: string): AgentRecord {
	assertAgentName(name);
	const record = Object.hasOwn(curator.state.agents, name) ? curator.state.agents[name] : undefined;
	if (!record) throw new Error(`unknown agent "${name}" (run \`omp-curator scan\` or \`run --dry-run\` after adding it)`);
	return record;
}

/**
 * Move an agent definition out of `~/.omp/agent/agents`, so OMP no longer offers it. Crash-safe:
 * the destination is saved as a pending intent before the move, and the next pass finishes or
 * rolls back an interrupted archive.
 */
export async function archiveAgent(curator: Curator, name: string, reason: string, actor: Actor): Promise<string> {
	const record = agentRecord(curator, name);
	if (record.state === "archived") throw new Error(`agent "${name}" is already archived`);
	const src = join(curator.paths.agentDefsDir, `${name}.md`);
	if (!(await exists(src))) throw new Error(`no agent definition at ${src}`);
	const now = curator.now.toISOString();
	let dest = join(curator.paths.agentArchiveDir, `${name}.md`);
	if (await exists(dest)) dest = join(curator.paths.agentArchiveDir, `${name}@${stamp(curator.now)}.md`);
	record.archive = { path: dest, at: now, reason, pending: true };
	await curator.save();
	try {
		await moveEntry(src, dest);
	} catch (error) {
		delete record.archive;
		await curator.save();
		throw error;
	}
	record.state = "archived";
	record.stateSince = now;
	delete record.archive.pending;
	await curator.save();
	await curator.ledger(actor, "agent-archive", name, reason);
	return dest;
}

export async function restoreAgent(curator: Curator, name: string, actor: Actor): Promise<string> {
	const record = agentRecord(curator, name);
	if (record.state !== "archived" || !record.archive) throw new Error(`agent "${name}" is not archived`);
	const dest = join(curator.paths.agentDefsDir, `${name}.md`);
	if (await exists(dest)) throw new Error(`agent "${name}" already exists at ${dest}; run \`omp-curator run\` to reconcile`);
	await moveEntry(record.archive.path, dest);
	const now = curator.now.toISOString();
	Object.assign(record, { state: "active", stateSince: now, floorAt: now });
	delete record.archive;
	await curator.save();
	await curator.ledger(actor, "agent-restore", name);
	return dest;
}

export async function purgeAgent(curator: Curator, name: string, actor: Actor): Promise<string> {
	const record = agentRecord(curator, name);
	if (record.state !== "archived" || !record.archive) throw new Error(`agent "${name}" is not archived`);
	const path = record.archive.path;
	await rm(path, { force: true });
	delete curator.state.agents[name];
	await curator.save();
	await curator.ledger(actor, "agent-purge", name, path);
	return path;
}

export async function setAgentPinned(curator: Curator, name: string, pinned: boolean, actor: Actor): Promise<void> {
	const record = agentRecord(curator, name);
	if (pinned) record.pinned = true;
	else delete record.pinned;
	await curator.save();
	await curator.ledger(actor, pinned ? "agent-pin" : "agent-unpin", name);
}
