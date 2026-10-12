import { rm } from "node:fs/promises";
import { join } from "node:path";
import { daysBetween, exists, moveEntry, stamp } from "./fsutil.ts";
import { INTEGRATIONS } from "./integrations/index.ts";
import type { Integration, IntegrationContext } from "./integrations/types.ts";
import { autoloadReferences, listSkills } from "./inventory.ts";
import type { SkillEntry } from "./inventory.ts";
import { resolvePaths } from "./paths.ts";
import type { Paths } from "./paths.ts";
import { appendLedger, loadConfig, loadState, saveState } from "./store.ts";
import type { CuratorConfig, CuratorState, LedgerEntry, SkillRecord } from "./store.ts";
import { aggregate, loadUsage, mergeUsage, saveUsage } from "./usage/db.ts";
import type { SkillUsage } from "./usage/db.ts";
import { USAGE_SOURCES, scanUsage } from "./usage/index.ts";
import type { ScanResult, UsageDb, UsageSource } from "./usage/types.ts";

export type Actor = LedgerEntry["actor"];

/** `due` = idle past `archiveAfterDays` and eligible for archiving. */
export type Status = "active" | "stale" | "due" | "archived";

export interface Assessment {
	name: string;
	status: Status;
	idleDays: number;
	/** Start of the idle window: max(last use, the time the skill became available). */
	idleSince: string;
	usage?: SkillUsage;
	pinned: boolean;
	/** Why automatic archiving skips this skill. */
	protectedBy?: string;
	origin?: string;
	entry?: SkillEntry;
	record: SkillRecord;
}

export interface Transition {
	name: string;
	from: Status | "new" | "missing";
	to: Status | "removed";
	detail?: string;
}

export interface RunReport {
	scan: Record<string, ScanResult>;
	transitions: Transition[];
	dryRun: boolean;
}

export interface CuratorOptions {
	paths?: Paths;
	sources?: readonly UsageSource[];
	integrations?: readonly Integration[];
	now?: () => Date;
}

/** Glob with `*` wildcards only, anchored. */
function globMatch(pattern: string, name: string): boolean {
	const re = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	return re.test(name);
}

/** Skill names become path segments; reject anything that could escape the store. */
export function assertSkillName(name: string): void {
	if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error(`invalid skill name "${name}"`);
}

export class Curator {
	readonly paths: Paths;
	readonly sources: readonly UsageSource[];
	readonly integrations: readonly Integration[];
	readonly #now: () => Date;
	config!: CuratorConfig;
	state!: CuratorState;
	usage!: UsageDb;

	private constructor(options: CuratorOptions) {
		this.paths = options.paths ?? resolvePaths();
		this.sources = options.sources ?? USAGE_SOURCES;
		this.integrations = options.integrations ?? INTEGRATIONS;
		this.#now = options.now ?? (() => new Date());
	}

	static async open(options: CuratorOptions = {}): Promise<Curator> {
		const curator = new Curator(options);
		await curator.reload();
		return curator;
	}

	async reload(): Promise<void> {
		[this.config, this.state, this.usage] = await Promise.all([
			loadConfig(this.paths),
			loadState(this.paths),
			loadUsage(this.paths),
		]);
	}

	async save(): Promise<void> {
		await Promise.all([saveState(this.paths, this.state), saveUsage(this.paths, this.usage)]);
	}

	get now(): Date {
		return this.#now();
	}

	get integrationContext(): IntegrationContext {
		return { paths: this.paths, config: this.config };
	}

	/** The ledger is an audit trail; failing to append must never block a state change. */
	async ledger(actor: Actor, action: string, skill?: string, detail?: string): Promise<void> {
		try {
			await appendLedger(this.paths, { actor, action, skill, detail });
		} catch {
			// best effort
		}
	}

	/** Whether the automatic pass is due (first-run passes are deferred by one interval). */
	isDue(): boolean {
		if (!this.state.lastRunAt) return false;
		return this.now.getTime() - new Date(this.state.lastRunAt).getTime() >= this.config.intervalHours * 3_600_000;
	}

	/** Store key of a skill given the name OMP registers it under (directory or frontmatter name). */
	resolveName(name: string): string | undefined {
		if (Object.hasOwn(this.state.skills, name)) return name;
		return Object.keys(this.state.skills).find(key => this.state.skills[key]!.registeredName === name);
	}

	async scan(): Promise<Record<string, ScanResult>> {
		const known = new Set(Object.keys(this.state.skills));
		for (const record of Object.values(this.state.skills)) if (record.registeredName) known.add(record.registeredName);
		for (const entry of await listSkills(this.paths.skillsDir)) {
			known.add(entry.name);
			if (entry.frontmatterName) known.add(entry.frontmatterName);
		}
		return scanUsage({ paths: this.paths, db: this.usage, known }, this.config.sources, this.sources);
	}

	async #applyIntegrations(hook: "afterArchive" | "afterRestore", name: string, stash: Record<string, unknown> | undefined): Promise<void> {
		for (const integration of this.integrations) await integration[hook]?.(this.integrationContext, name, stash?.[integration.id]);
	}

	/**
	 * Reconcile state with the store: record new skills, finish or roll back archives and
	 * restores interrupted midway, notice reinstalls (also while archived) and drop records
	 * of skills removed outside the curator.
	 */
	async sync(actor: Actor, dryRun = false): Promise<Transition[]> {
		const now = this.now.toISOString();
		const entries = new Map((await listSkills(this.paths.skillsDir)).map(entry => [entry.name, entry]));
		const transitions: Transition[] = [];

		for (const [name, record] of Object.entries(this.state.skills)) {
			if (!record.archive?.pending) continue;
			const from = record.state;
			if ((await exists(record.archive.path)) && !entries.has(name)) {
				if (!dryRun) await this.#applyIntegrations("afterArchive", name, record.archive.stash);
				record.state = "archived";
				record.stateSince = now;
				delete record.archive.pending;
				transitions.push({ name, from, to: "archived", detail: "completed an interrupted archive" });
			} else {
				delete record.archive;
				transitions.push({ name, from, to: from, detail: "rolled back an interrupted archive" });
			}
		}

		for (const entry of entries.values()) {
			const record = Object.hasOwn(this.state.skills, entry.name) ? this.state.skills[entry.name] : undefined;
			const registeredName = entry.frontmatterName && entry.frontmatterName !== entry.name ? entry.frontmatterName : undefined;
			if (!record) {
				this.state.skills[entry.name] = {
					firstSeen: now,
					floorAt: entry.createdAt.toISOString(),
					state: "active",
					stateSince: now,
					entryId: entry.entryId,
					...(registeredName ? { registeredName } : {}),
				};
				transitions.push({ name: entry.name, from: "new", to: "active" });
				continue;
			}
			if (record.state === "archived") {
				const archivePath = record.archive?.path;
				const interruptedRestore = archivePath !== undefined && !(await exists(archivePath));
				if (interruptedRestore && !dryRun) await this.#applyIntegrations("afterRestore", entry.name, record.archive?.stash);
				transitions.push({
					name: entry.name,
					from: "archived",
					to: "active",
					detail: interruptedRestore ? "completed an interrupted restore" : `reinstalled while archived; archived copy kept at ${archivePath}`,
				});
				if (!dryRun) await this.ledger(actor, interruptedRestore ? "restore" : "reinstated", entry.name, archivePath);
				record.state = "active";
				record.stateSince = now;
				record.floorAt = now;
				delete record.archive;
			} else if (record.entryId && record.entryId !== entry.entryId) {
				// `skills add`/`update`, `track` and installers recreate the directory.
				transitions.push({ name: entry.name, from: record.state, to: "active", detail: "reinstalled; idle time reset" });
				if (!dryRun) await this.ledger(actor, "reinstalled", entry.name);
				record.state = "active";
				record.stateSince = now;
				record.floorAt = now;
			}
			record.entryId = entry.entryId;
			if (registeredName) record.registeredName = registeredName;
			else delete record.registeredName;
		}

		for (const [name, record] of Object.entries(this.state.skills)) {
			if (record.state === "archived") {
				if (record.archive && !(await exists(record.archive.path))) {
					delete this.state.skills[name];
					transitions.push({ name, from: "archived", to: "removed", detail: "archived copy deleted outside omp-curator" });
					if (!dryRun) await this.ledger(actor, "forgotten", name, "archive missing");
				}
			} else if (!entries.has(name)) {
				delete this.state.skills[name];
				transitions.push({ name, from: "missing", to: "removed", detail: "removed from the store outside omp-curator" });
				if (!dryRun) await this.ledger(actor, "forgotten", name, "store entry missing");
			}
		}
		return transitions;
	}

	async assess(): Promise<Assessment[]> {
		const now = this.now;
		const usage = aggregate(this.usage.events);
		const entries = new Map((await listSkills(this.paths.skillsDir)).map(entry => [entry.name, entry]));
		const autoload = await autoloadReferences(this.paths);
		const origins: Record<string, string> = Object.create(null);
		for (const integration of this.integrations) Object.assign(origins, await integration.origins?.(this.integrationContext));
		const out: Assessment[] = [];
		for (const [name, record] of Object.entries(this.state.skills).sort(([a], [b]) => a.localeCompare(b))) {
			// OMP records invocations under the registered (frontmatter) name.
			const names = record.registeredName ? [name, record.registeredName] : [name];
			const stats = mergeUsage(names.map(key => usage.get(key)));
			const idleSince = stats?.lastUsed && stats.lastUsed > record.floorAt ? stats.lastUsed : record.floorAt;
			const idleDays = Math.max(0, daysBetween(idleSince, now));
			const pinned = record.pinned === true;
			const pattern = this.config.protect.find(glob => names.some(key => globMatch(glob, key)));
			const autoloadedBy = names.flatMap(key => autoload.get(key) ?? []);
			let protectedBy: string | undefined;
			if (pinned) protectedBy = "pinned";
			else if (pattern) protectedBy = `protect: ${pattern}`;
			else if (autoloadedBy.length) protectedBy = `autoload: ${autoloadedBy.join(", ")}`;
			let status: Status;
			if (record.state === "archived") status = "archived";
			else if (idleDays >= this.config.archiveAfterDays && !protectedBy) status = "due";
			else if (idleDays >= this.config.staleAfterDays) status = "stale";
			else status = "active";
			const entry = entries.get(name);
			const origin = origins[name] ?? (entry?.linkTarget ? `link:${entry.linkTarget}` : undefined);
			out.push({ name, status, idleDays, idleSince, usage: stats, pinned, protectedBy, origin, entry, record });
		}
		return out;
	}

	/**
	 * Scan usage, reconcile the store, relabel stale skills and archive due ones. A dry run
	 * works on a copy of the state and writes nothing.
	 */
	async run(actor: Actor, options: { dryRun?: boolean; allowArchive?: boolean } = {}): Promise<RunReport> {
		const dryRun = options.dryRun ?? false;
		const allowArchive = options.allowArchive ?? this.config.autoArchive;
		const snapshot = dryRun ? structuredClone(this.state) : undefined;
		const scan = await this.scan();
		const transitions = await this.sync(actor, dryRun);
		const now = this.now.toISOString();
		for (const item of await this.assess()) {
			if (item.status === "archived") continue;
			if (item.status === "due" && allowArchive) {
				transitions.push({ name: item.name, from: item.record.state, to: "archived", detail: `idle ${item.idleDays}d` });
				if (!dryRun) await this.archive(item.name, `idle ${item.idleDays} days`, actor);
				continue;
			}
			const label = item.status === "due" ? "stale" : item.status;
			if (label === item.record.state) continue;
			transitions.push({ name: item.name, from: item.record.state, to: label, detail: `idle ${item.idleDays}d` });
			item.record.state = label;
			item.record.stateSince = now;
			if (!dryRun) await this.ledger(actor, label, item.name, `idle ${item.idleDays}d`);
		}
		if (snapshot) {
			// structuredClone drops the null prototype `loadState` gives the skill map.
			this.state = { ...snapshot, skills: Object.assign(Object.create(null), snapshot.skills) };
		} else {
			this.state.lastRunAt = now;
			await this.save();
		}
		return { scan, transitions, dryRun };
	}

	/**
	 * Move a skill out of the store. Crash-safe: integration captures and the destination are
	 * persisted as a pending intent before anything moves, integrations apply their change
	 * only after the move, and `sync()` finishes or rolls back an interrupted archive.
	 */
	async archive(name: string, reason: string, actor: Actor): Promise<string> {
		assertSkillName(name);
		const src = join(this.paths.skillsDir, name);
		if (!(await exists(src))) throw new Error(`no skill "${name}" in ${this.paths.skillsDir}`);
		const now = this.now.toISOString();
		this.state.skills[name] ??= { firstSeen: now, floorAt: now, state: "active", stateSince: now };
		const record = this.state.skills[name]!;
		const stash: Record<string, unknown> = {};
		for (const integration of this.integrations) {
			const data = await integration.beforeArchive?.(this.integrationContext, name);
			if (data !== undefined) stash[integration.id] = data;
		}
		let dest = join(this.paths.archiveDir, name);
		if (await exists(dest)) dest = join(this.paths.archiveDir, `${name}@${stamp(this.now)}`);
		record.archive = { path: dest, at: now, reason, pending: true, ...(Object.keys(stash).length ? { stash } : {}) };
		await this.save();
		try {
			await moveEntry(src, dest);
		} catch (error) {
			delete record.archive;
			await this.save();
			throw error;
		}
		await this.#applyIntegrations("afterArchive", name, record.archive.stash);
		record.state = "archived";
		record.stateSince = now;
		delete record.archive.pending;
		await this.save();
		await this.ledger(actor, "archive", name, reason);
		return dest;
	}

	async restore(name: string, actor: Actor): Promise<string> {
		const record = Object.hasOwn(this.state.skills, name) ? this.state.skills[name] : undefined;
		if (record?.state !== "archived" || !record.archive) throw new Error(`"${name}" is not archived`);
		const dest = join(this.paths.skillsDir, name);
		if (await exists(dest)) throw new Error(`"${name}" is already installed again at ${dest}; run \`omp-curator run\` to reconcile`);
		// After this move an interrupted restore is completed by `sync()` (archive gone, entry present).
		await moveEntry(record.archive.path, dest);
		await this.#applyIntegrations("afterRestore", name, record.archive.stash);
		const now = this.now.toISOString();
		record.state = "active";
		record.stateSince = now;
		record.floorAt = now;
		// The moved entry may have a new identity; the next sync records it without a reinstall.
		delete record.entryId;
		delete record.archive;
		await this.save();
		await this.ledger(actor, "restore", name);
		return dest;
	}

	/** Permanently delete archived copies. */
	async purge(name: string, actor: Actor): Promise<string> {
		const record = Object.hasOwn(this.state.skills, name) ? this.state.skills[name] : undefined;
		if (record?.state !== "archived" || !record.archive) throw new Error(`"${name}" is not archived`);
		const path = record.archive.path;
		await rm(path, { recursive: true, force: true });
		delete this.state.skills[name];
		await this.save();
		await this.ledger(actor, "purge", name, path);
		return path;
	}

	async setPinned(name: string, pinned: boolean, actor: Actor): Promise<void> {
		const record = this.state.skills[name];
		if (!record) throw new Error(`unknown skill "${name}"; run \`omp-curator run\` first`);
		if (pinned) record.pinned = true;
		else delete record.pinned;
		await this.ledger(actor, pinned ? "pin" : "unpin", name);
		await this.save();
	}
}
