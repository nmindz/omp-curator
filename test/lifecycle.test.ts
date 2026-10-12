import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../src/fsutil.ts";
import { readLock, writeLock } from "../src/integrations/vercel/lock.ts";
import type { SkillLockEntry } from "../src/integrations/vercel/lock.ts";
import { DAY, daysAgo, ompToolCall, sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

const lockEntry = (name: string): SkillLockEntry => ({
	source: "acme/skills",
	sourceType: "github",
	sourceUrl: "https://github.com/acme/skills.git",
	skillPath: `skills/${name}/SKILL.md`,
	skillFolderHash: "a".repeat(40),
	installedAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
});

async function seeded(skills: Record<string, number>): Promise<Sandbox> {
	const sb = await sandbox();
	for (const [name, age] of Object.entries(skills)) await sb.addSkill(name, { createdDaysAgo: age });
	return sb;
}

async function statusOf(name: string) {
	const curator = await box.open();
	return (await curator.assess()).find(item => item.name === name);
}

describe("assessment", () => {
	test("idle time starts at availability, so old usage elsewhere does not make a new skill stale", async () => {
		box = await seeded({ fresh: 2, old: 120 });
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [
			ompToolCall(daysAgo(box.clock, 400), "read", { path: "skill://fresh" }),
			ompToolCall(daysAgo(box.clock, 40), "read", { path: "skill://old" }),
		]);
		const curator = await box.open();
		await curator.run("user", { allowArchive: false });
		expect(await statusOf("fresh")).toMatchObject({ status: "active", idleDays: 2 });
		expect(await statusOf("old")).toMatchObject({ status: "stale", idleDays: 40 });
	});

	test("thresholds and protection: pin, protect glob, agent autoload", async () => {
		box = await seeded({ a: 100, b: 100, c: 100, keep: 100, build: 100 });
		await mkdir(box.paths.agentDefsDir, { recursive: true });
		await writeFile(join(box.paths.agentDefsDir, "builder.md"), "---\nname: builder\nautoloadSkills: [build]\n---\nx");
		const curator = await box.open();
		await curator.run("user", { allowArchive: false });
		await curator.setPinned("a", true, "user");
		await writeFile(box.paths.configPath, JSON.stringify({ protect: ["ke*"] }));
		const items = Object.fromEntries((await (await box.open()).assess()).map(item => [item.name, item]));
		expect(items.a).toMatchObject({ status: "stale", protectedBy: "pinned" });
		expect(items.keep).toMatchObject({ status: "stale", protectedBy: "protect: ke*" });
		expect(items.build).toMatchObject({ status: "stale", protectedBy: "autoload: builder" });
		expect(items.b?.status).toBe("due");
		expect(items.c?.status).toBe("due");
	});
});

describe("run", () => {
	test("dry run writes nothing", async () => {
		box = await seeded({ idle: 100 });
		const curator = await box.open();
		const report = await curator.run("user", { dryRun: true });
		expect(report.transitions.map(t => `${t.name}:${t.to}`)).toEqual(["idle:active", "idle:archived"]);
		expect(await exists(join(box.paths.skillsDir, "idle"))).toBe(true);
		expect(await exists(box.paths.statePath)).toBe(false);
		expect(curator.state.skills).toEqual({});
	});

	test("archives due skills, stashing and restoring the skills lock entry", async () => {
		box = await seeded({ idle: 100, busy: 100 });
		await writeLock(box.paths, { version: 3, skills: { idle: lockEntry("idle"), busy: lockEntry("busy") }, lastSelectedAgents: ["pi"] });
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [ompToolCall(daysAgo(box.clock, 1), "read", { path: "skill://busy" })]);
		const curator = await box.open();
		const report = await curator.run("user");
		expect(report.transitions.filter(t => t.to === "archived").map(t => t.name)).toEqual(["idle"]);
		expect(await exists(join(box.paths.skillsDir, "idle"))).toBe(false);
		expect(await exists(join(box.paths.archiveDir, "idle", "SKILL.md"))).toBe(true);
		const lock = await readLock(box.paths);
		expect(Object.keys(lock.skills)).toEqual(["busy"]);
		expect(lock.lastSelectedAgents).toEqual(["pi"]);

		box.clock.now = new Date(box.clock.now.getTime() + DAY);
		const reopened = await box.open();
		await reopened.restore("idle", "user");
		expect(await exists(join(box.paths.skillsDir, "idle", "SKILL.md"))).toBe(true);
		expect((await readLock(box.paths)).skills.idle).toEqual(lockEntry("idle"));
		expect(await statusOf("idle")).toMatchObject({ status: "active", idleDays: 0 });
		const ledger = await readFile(box.paths.ledgerPath, "utf8");
		expect(ledger).toContain('"action":"archive"');
		expect(ledger).toContain('"action":"restore"');
	});

	test("a skill reinstalled while archived becomes active and keeps the newer lock entry", async () => {
		box = await seeded({ x: 1 });
		await writeLock(box.paths, { version: 3, skills: { x: lockEntry("x") } });
		const curator = await box.open();
		await curator.run("user");
		await curator.archive("x", "manual", "user");
		await box.addSkill("x");
		const fresher = { ...lockEntry("x"), skillFolderHash: "b".repeat(40) };
		await writeLock(box.paths, { version: 3, skills: { x: fresher } });
		const report = await (await box.open()).run("user");
		expect(report.transitions).toContainEqual(expect.objectContaining({ name: "x", from: "archived", to: "active" }));
		expect((await readLock(box.paths)).skills.x).toEqual(fresher);
	});

	test("skills removed outside the curator are forgotten", async () => {
		box = await seeded({ gone: 1 });
		const curator = await box.open();
		await curator.run("user");
		await rm(join(box.paths.skillsDir, "gone"), { recursive: true });
		const report = await (await box.open()).run("user");
		expect(report.transitions).toContainEqual(expect.objectContaining({ name: "gone", to: "removed" }));
		expect((await box.open()).state.skills.gone).toBeUndefined();
	});
});

describe("archive and restore", () => {
	test("symlinked skills move as absolute links and keep resolving", async () => {
		box = await sandbox();
		const target = join(box.root, "vendor", "linked");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "SKILL.md"), "---\nname: linked\ndescription: d\n---\n");
		await symlink("../../../vendor/linked", join(box.paths.skillsDir, "linked"));
		const curator = await box.open();
		const dest = await curator.archive("linked", "manual", "user");
		expect((await lstat(dest)).isSymbolicLink()).toBe(true);
		expect(await readlink(dest)).toBe(target);
		expect(await exists(target)).toBe(true);
		await curator.restore("linked", "user");
		expect(await readFile(join(box.paths.skillsDir, "linked", "SKILL.md"), "utf8")).toContain("name: linked");
	});

	test("names that escape the store are rejected before anything moves", async () => {
		box = await seeded({ ok: 1 });
		await mkdir(join(box.root, "outside"), { recursive: true });
		const curator = await box.open();
		for (const name of ["../../outside", "..", "a/b", ""]) {
			await expect(curator.archive(name, "manual", "user")).rejects.toThrow(/invalid skill name/);
		}
		expect(await exists(join(box.root, "outside"))).toBe(true);
	});

	test("an occupied archive slot gets a timestamped name", async () => {
		box = await seeded({ dup: 1 });
		await mkdir(join(box.paths.archiveDir, "dup"), { recursive: true });
		const dest = await (await box.open()).archive("dup", "manual", "user");
		expect(dest).toMatch(/archive\/dup@\d{4}-/);
	});

	test("restore refuses to overwrite a reinstalled skill; purge deletes the archive", async () => {
		box = await seeded({ y: 1 });
		const curator = await box.open();
		const dest = await curator.archive("y", "manual", "user");
		await box.addSkill("y");
		await expect(curator.restore("y", "user")).rejects.toThrow(/already installed/);
		await curator.purge("y", "user");
		expect(await exists(dest)).toBe(false);
		expect(curator.state.skills.y).toBeUndefined();
	});

	test("a failed move puts the lock entry back", async () => {
		box = await seeded({ z: 1 });
		await writeLock(box.paths, { version: 3, skills: { z: lockEntry("z") } });
		// A file where the archive root should be makes the move fail.
		await mkdir(box.paths.curatorDir, { recursive: true });
		await writeFile(box.paths.archiveDir, "not a directory");
		await expect((await box.open()).archive("z", "manual", "user")).rejects.toThrow();
		expect((await readLock(box.paths)).skills.z).toEqual(lockEntry("z"));
		expect(await exists(join(box.paths.skillsDir, "z"))).toBe(true);
	});
});

describe("automatic pass scheduling", () => {
	test("never due before init or within the interval", async () => {
		box = await seeded({ a: 1 });
		const curator = await box.open();
		expect(curator.isDue()).toBe(false);
		await curator.run("user");
		box.clock.now = new Date(box.clock.now.getTime() + 167 * 3_600_000);
		expect((await box.open()).isDue()).toBe(false);
		box.clock.now = new Date(box.clock.now.getTime() + 3_600_000);
		expect((await box.open()).isDue()).toBe(true);
	});
});
