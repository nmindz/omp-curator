import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { exists, moveEntry } from "../src/fsutil.ts";
import { vercelIntegration } from "../src/integrations/vercel/index.ts";
import { linkAgentsDir, linkStatus } from "../src/integrations/vercel/link.ts";
import { readLock, writeLock } from "../src/integrations/vercel/lock.ts";
import type { SkillLockEntry } from "../src/integrations/vercel/lock.ts";
import { withMutex } from "../src/mutex.ts";
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

async function realSkill(root: string, name: string, body = "x"): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}`);
	return dir;
}

describe("link migration never deletes the only copy", () => {
	test("a store entry aliasing ~/.agents/skills is replaced by the real directory", async () => {
		box = await sandbox();
		await realSkill(box.paths.agentsSkillsDir, "foo", "only copy");
		await symlink(join(box.paths.agentsSkillsDir, "foo"), join(box.paths.skillsDir, "foo"));
		await writeFile(join(box.paths.agentsSkillsDir, ".DS_Store"), "junk");
		const report = await linkAgentsDir(box.paths, false);
		expect(report.replacedAliases).toEqual(["foo"]);
		expect(report.removedJunk).toEqual([".DS_Store"]);
		expect((await linkStatus(box.paths)).kind).toBe("linked");
		expect(await readFile(join(box.paths.skillsDir, "foo", "SKILL.md"), "utf8")).toContain("only copy");
	});

	test("refuses when the store itself is a link to ~/.agents/skills", async () => {
		box = await sandbox();
		await rm(box.paths.skillsDir, { recursive: true });
		await realSkill(box.paths.agentsSkillsDir, "foo");
		await symlink(box.paths.agentsSkillsDir, box.paths.skillsDir);
		await expect(linkAgentsDir(box.paths, false)).rejects.toThrow(/resolve into each other/);
		expect(await exists(join(box.paths.agentsSkillsDir, "foo", "SKILL.md"))).toBe(true);
	});

	test("doctor --fix ignores harness dirs that alias the store", async () => {
		box = await sandbox();
		await realSkill(box.paths.skillsDir, "foo");
		await symlink(join(box.paths.skillsDir, "foo"), join(box.paths.skillsDir, "bar"));
		await linkAgentsDir(box.paths, false);
		await mkdir(join(box.root, ".claude"), { recursive: true });
		await symlink(box.paths.skillsDir, join(box.root, ".claude", "skills"));
		const ctx = { paths: box.paths, config: (await box.open()).config };
		expect(await vercelIntegration.fix!(ctx)).toEqual([]);
		expect(await exists(join(box.paths.skillsDir, "bar", "SKILL.md"))).toBe(true);
		expect((await vercelIntegration.doctor!(ctx)).map(f => f.message).join("\n")).toContain("loads every OMP skill");
	});
});

describe("mutex ownership", () => {
	test("a lock from a dead process is broken; a live owner's lock is never removed by others", async () => {
		box = await sandbox();
		await mkdir(box.paths.curatorDir, { recursive: true });
		const lockPath = join(box.paths.curatorDir, "curator.lock");
		await writeFile(lockPath, "999999 dead-owner");
		expect(await withMutex(box.paths, async () => "acquired", 0)).toBe("acquired");

		await writeFile(lockPath, `${process.pid} someone-else`);
		await expect(withMutex(box.paths, async () => "x", 0)).rejects.toThrow(/busy/);
		expect(await readFile(lockPath, "utf8")).toBe(`${process.pid} someone-else`);
	});
});

describe("crash-safe archive", () => {
	test("an interrupted archive (moved, not committed) is completed and its lock entry removed", async () => {
		box = await sandbox();
		await box.addSkill("x");
		await writeLock(box.paths, { version: 3, skills: { x: lockEntry("x") } });
		const curator = await box.open();
		await curator.run("user");
		const dest = join(box.paths.archiveDir, "x");
		curator.state.skills.x!.archive = { path: dest, at: box.clock.now.toISOString(), reason: "r", pending: true, stash: { "vercel-skills": lockEntry("x") } };
		await curator.save();
		await moveEntry(join(box.paths.skillsDir, "x"), dest);

		const report = await (await box.open()).run("user");
		expect(report.transitions).toContainEqual(expect.objectContaining({ name: "x", to: "archived" }));
		expect((await readLock(box.paths)).skills.x).toBeUndefined();
		await (await box.open()).restore("x", "user");
		expect((await readLock(box.paths)).skills.x).toEqual(lockEntry("x"));
	});

	test("an archive interrupted before the move is rolled back", async () => {
		box = await sandbox();
		await box.addSkill("y");
		const curator = await box.open();
		await curator.run("user");
		curator.state.skills.y!.archive = { path: join(box.paths.archiveDir, "y"), at: box.clock.now.toISOString(), reason: "r", pending: true };
		await curator.save();
		await (await box.open()).run("user");
		const record = (await box.open()).state.skills.y!;
		expect(record.state).toBe("active");
		expect(record.archive).toBeUndefined();
	});

	test("an unwritable ledger does not leave a half-archived skill", async () => {
		box = await sandbox();
		await box.addSkill("z");
		await mkdir(box.paths.ledgerPath, { recursive: true });
		const curator = await box.open();
		await curator.archive("z", "manual", "user");
		expect((await box.open()).state.skills.z?.state).toBe("archived");
	});

	test("an interrupted restore (moved back, not committed) is completed with its lock entry", async () => {
		box = await sandbox();
		await box.addSkill("w");
		await writeLock(box.paths, { version: 3, skills: { w: lockEntry("w") } });
		const curator = await box.open();
		const dest = await curator.archive("w", "manual", "user");
		await moveEntry(dest, join(box.paths.skillsDir, "w"));
		const report = await (await box.open()).run("user");
		expect(report.transitions).toContainEqual(expect.objectContaining({ name: "w", detail: "completed an interrupted restore" }));
		expect((await readLock(box.paths)).skills.w).toEqual(lockEntry("w"));
	});
});

describe("lifecycle evidence", () => {
	test("comma-separated autoloadSkills protects every listed skill", async () => {
		box = await sandbox();
		await box.addSkill("deploy", { createdDaysAgo: 200 });
		await box.addSkill("plan", { createdDaysAgo: 200 });
		await mkdir(box.paths.agentDefsDir, { recursive: true });
		await writeFile(join(box.paths.agentDefsDir, "shipper.md"), "---\nname: shipper\nautoloadSkills: deploy, plan\n---\nx");
		const report = await (await box.open()).run("user");
		expect(report.transitions.filter(t => t.to === "archived")).toEqual([]);
	});

	test("usage recorded under the frontmatter name counts for the directory", async () => {
		box = await sandbox();
		await box.addSkill("local-copy", { createdDaysAgo: 200 });
		await writeFile(join(box.paths.skillsDir, "local-copy", "SKILL.md"), "---\nname: actual-name\ndescription: d\n---\n");
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [ompToolCall(daysAgo(box.clock, 1), "read", { path: "skill://actual-name" })]);
		const curator = await box.open();
		await curator.run("user");
		const item = (await curator.assess()).find(entry => entry.name === "local-copy");
		expect(item).toMatchObject({ status: "active", idleDays: 1 });
		expect(curator.resolveName("actual-name")).toBe("local-copy");
	});

	test("a reinstall resets idle time", async () => {
		box = await sandbox();
		await box.addSkill("r", { createdDaysAgo: 100 });
		await (await box.open()).run("user", { allowArchive: false });
		await rm(join(box.paths.skillsDir, "r"), { recursive: true });
		await box.addSkill("r");
		const report = await (await box.open()).run("user");
		expect(report.transitions).toContainEqual(expect.objectContaining({ name: "r", detail: "reinstalled; idle time reset" }));
		expect(report.transitions.filter(t => t.to === "archived")).toEqual([]);
	});

	test("a symlink added today to an old vendor checkout is available from today", async () => {
		box = await sandbox();
		const vendor = await realSkill(join(box.root, "vendor"), "linked");
		const old = new Date(box.clock.now.getTime() - 200 * DAY);
		await utimes(vendor, old, old);
		await symlink(vendor, join(box.paths.skillsDir, "linked"));
		// The sandbox clock is fixed; move it to the real present so the link's own birth time counts as today.
		box.clock.now = new Date();
		const report = await (await box.open()).run("user");
		expect(report.transitions.filter(t => t.to === "archived")).toEqual([]);
	});

	test("prune refreshes usage before choosing what to archive", async () => {
		box = await sandbox();
		await box.addSkill("p", { createdDaysAgo: 200 });
		const cli = (...argv: string[]) => runCli(argv, { paths: box.paths, now: () => box.clock.now });
		await cli("init");
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [ompToolCall(daysAgo(box.clock, 1), "read", { path: "skill://p" })]);
		expect((await cli("prune", "--days", "90")).out).toContain("nothing idle");
		expect(await exists(join(box.paths.skillsDir, "p"))).toBe(true);
	});

	test("a skill named like an Object.prototype key is tracked and archived normally", async () => {
		box = await sandbox();
		await box.addSkill("constructor");
		// No pass first: archive() must create the record itself.
		await (await box.open()).archive("constructor", "manual", "user");
		const key: string = "constructor";
		expect((await box.open()).state.skills[key]?.state).toBe("archived");
		await (await box.open()).restore("constructor", "user");
		expect(await exists(join(box.paths.skillsDir, "constructor", "SKILL.md"))).toBe(true);
	});

	test("update --dry-run writes no state", async () => {
		box = await sandbox();
		await runCli(["update", "--dry-run"], { paths: box.paths });
		expect(await exists(box.paths.statePath)).toBe(false);
		expect(await exists(box.paths.usagePath)).toBe(false);
	});
});
