import { afterEach, describe, expect, test } from "bun:test";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { exists } from "../src/fsutil.ts";
import { withMutex } from "../src/mutex.ts";
import { daysAgo, ompToolCall, sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

const cli = (...argv: string[]) => runCli(argv, { paths: box.paths, now: () => box.clock.now });

describe("cli", () => {
	test("init links, backfills and lists usage; archive/restore round trip", async () => {
		box = await sandbox();
		await box.addSkill("used", { createdDaysAgo: 200 });
		await box.addSkill("idle", { createdDaysAgo: 200 });
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [ompToolCall(daysAgo(box.clock, 3), "read", { path: "skill://used" })]);

		const init = await cli("init");
		expect(init.code).toBe(0);
		expect(init.out).toContain("tracking 2 newly seen skill(s)");
		expect(init.out).toContain("idle: active → stale");
		expect(await readlink(box.paths.agentsSkillsDir)).toBe(box.paths.skillsDir);
		expect(await exists(join(box.paths.skillsDir, "idle"))).toBe(true);

		const list = JSON.parse((await cli("list", "--json", "--sort", "uses")).out) as Array<{ name: string; status: string; usage?: { uses: number } }>;
		expect(list.map(item => [item.name, item.status, item.usage?.uses ?? 0])).toEqual([
			["used", "active", 1],
			["idle", "due", 0],
		]);

		expect((await cli("archive", "idle", "--reason", "test")).out).toContain("archived idle");
		expect((await cli("list", "--state", "archived")).out).toContain("idle");
		expect((await cli("restore", "idle")).out).toContain("restored idle");
		expect((await cli("ledger")).out).toMatch(/archive\s+idle\s+test/);
	});

	test("init adopts history: a skill migrated into the store today but last used long ago is idle from its last use", async () => {
		box = await sandbox();
		await box.addSkill("migrated");
		await box.addSkill("brand-new");
		await box.writeJsonl(join(box.paths.claudeProjectsDir, "-p", "s.jsonl"), [
			{ type: "assistant", timestamp: daysAgo(box.clock, 200), message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "migrated" } }] } },
		]);
		await cli("init");
		const items = JSON.parse((await cli("list", "--json")).out) as Array<{ name: string; status: string; idleDays: number }>;
		expect(items.map(item => [item.name, item.status, item.idleDays])).toEqual([
			["migrated", "due", 200],
			["brand-new", "active", 0],
		]);
		// After init, a skill installed with old history elsewhere still gets the install grace.
		await box.addSkill("installed-later");
		await box.writeJsonl(join(box.paths.claudeProjectsDir, "-p", "t.jsonl"), [
			{ type: "assistant", timestamp: daysAgo(box.clock, 300), message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "installed-later" } }] } },
		]);
		await cli("run");
		const later = JSON.parse((await cli("list", "--json")).out) as Array<{ name: string; status: string }>;
		expect(later.find(item => item.name === "installed-later")?.status).toBe("active");
	});

	test("config validates keys and types", async () => {
		box = await sandbox();
		expect((await cli("config", "staleAfterDays", "45")).out).toBe("staleAfterDays = 45");
		await expect(cli("config", "staleAfterDays", "soon")).rejects.toThrow(/expects number/);
		await expect(cli("config", "nope", "1")).rejects.toThrow(/unknown config key/);
		expect(JSON.parse((await cli("config")).out).staleAfterDays).toBe(45);
	});

	test("a second mutator is refused while the mutex is held", async () => {
		box = await sandbox();
		await box.addSkill("a");
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = withMutex(box.paths, async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		await expect(withMutex(box.paths, async () => "second", 0)).rejects.toThrow(/busy/);
		release.resolve();
		await held;
		expect((await cli("run", "--dry-run")).code).toBe(0);
	});

	test("unknown commands exit 2 with help", async () => {
		box = await sandbox();
		const result = await cli("frobnicate");
		expect(result.code).toBe(2);
		expect(result.out).toContain("usage-driven lifecycle");
	});
});
