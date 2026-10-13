import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { exists, writeJsonAtomic } from "../src/fsutil.ts";
import { DAY, daysAgo, ompToolCall, sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

const cli = (...argv: string[]) => runCli(argv, { paths: box.paths, now: () => box.clock.now });

async function addAgent(name: string, autoload: string[] = []) {
	await mkdir(box.paths.agentDefsDir, { recursive: true });
	const front = [`name: ${name}`, `description: "Agent ${name}"`, ...(autoload.length ? [`autoloadSkills: [${autoload.join(", ")}]`] : [])];
	await writeFile(join(box.paths.agentDefsDir, `${name}.md`), `---\n${front.join("\n")}\n---\n\nDo ${name} work.\n`);
}

const spawnOmp = (daysBefore: number, ...agents: string[]) =>
	ompToolCall(daysAgo(box.clock, daysBefore), "task", { tasks: agents.map(agent => ({ agent, task: "x" })) });
const spawnClaude = (daysBefore: number, agent: string) => ({
	type: "assistant",
	timestamp: daysAgo(box.clock, daysBefore),
	message: { content: [{ type: "tool_use", name: "Task", input: { subagent_type: `plugin:${agent}`, prompt: "x" } }] },
});

type Row = { name: string; status: string; usage?: { spawns: number }; autoloadSkills: string[] };
const agents = async (...flags: string[]) => JSON.parse((await cli("agents", "list", "--json", ...flags)).out) as Row[];

describe("agent spawns", () => {
	test("OMP task calls and Claude Code Task calls count as spawns of the named agent", async () => {
		box = await sandbox();
		await addAgent("builder", ["build"]);
		await addAgent("quiet");
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [spawnOmp(2, "builder", "builder")]);
		await box.writeJsonl(join(box.paths.claudeProjectsDir, "-p", "s.jsonl"), [spawnClaude(3, "builder")]);
		await cli("scan");
		const rows = await agents();
		expect(rows.find(row => row.name === "builder")).toMatchObject({ usage: { spawns: 3 }, autoloadSkills: ["build"] });
		expect(rows.find(row => row.name === "quiet")?.usage).toBeUndefined();
	});

	test("history scanned before spawns were tracked is backfilled once, without double counting", async () => {
		box = await sandbox();
		await addAgent("builder");
		const file = join(box.paths.sessionsDir, "p", "s.jsonl");
		await box.writeJsonl(file, [spawnOmp(5, "builder")]);
		await cli("scan");
		// Simulate a usage db from before spawns existed: cursors set, no spawns recorded.
		const usage = JSON.parse(await readFile(box.paths.usagePath, "utf8")) as Record<string, unknown>;
		delete usage.spawns;
		delete usage.spawnsBackfilled;
		await writeJsonAtomic(box.paths.usagePath, usage);
		await writeFile(file, `${await readFile(file, "utf8")}${JSON.stringify(spawnOmp(1, "builder"))}\n`);
		await cli("scan");
		await cli("scan");
		expect((await agents()).find(row => row.name === "builder")?.usage?.spawns).toBe(2);
	});
});

describe("agent lifecycle", () => {
	test("a pass labels idle agents but archives them only with autoArchiveAgents", async () => {
		box = await sandbox();
		await addAgent("idle");
		await cli("init");
		box.clock.now = new Date(box.clock.now.getTime() + 120 * DAY);
		const preview = (await cli("run")).out;
		expect(preview).toContain("agent:idle: active → stale");
		expect(await exists(join(box.paths.agentDefsDir, "idle.md"))).toBe(true);

		await cli("config", "autoArchiveAgents", "true");
		expect((await cli("run")).out).toContain("agent:idle: stale → archived");
		expect(await exists(join(box.paths.agentDefsDir, "idle.md"))).toBe(false);
		expect(await exists(join(box.paths.agentArchiveDir, "idle.md"))).toBe(true);
	});

	test("pinned agents are never due", async () => {
		box = await sandbox();
		await addAgent("keep");
		await cli("init");
		await cli("agents", "pin", "keep");
		box.clock.now = new Date(box.clock.now.getTime() + 120 * DAY);
		expect((await agents()).find(row => row.name === "keep")?.status).toBe("stale");
	});

	test("archive, restore and purge move the definition; recreating an archived agent reactivates it", async () => {
		box = await sandbox();
		await addAgent("a");
		await addAgent("b");
		await cli("init");
		expect((await cli("agents", "archive", "a", "b", "--reason", "redundant")).out).toContain("archived agent a");
		expect((await agents("--state", "archived")).map(row => row.name)).toEqual(["a", "b"]);

		await cli("agents", "restore", "a");
		expect(await exists(join(box.paths.agentDefsDir, "a.md"))).toBe(true);

		await addAgent("b");
		expect((await cli("run", "--dry-run")).out).toContain("agent:b: archived → active (recreated while archived)");
		await cli("run");

		await cli("agents", "archive", "a");
		const archived = join(box.paths.agentArchiveDir, "a.md");
		expect((await cli("agents", "purge", "a")).out).toContain(archived);
		expect(await exists(archived)).toBe(false);
		expect((await agents()).map(row => row.name)).toEqual(["b"]);
		expect((await cli("ledger")).out).toMatch(/agent-archive\s+a\s+redundant/);
	});

	test("bad names and unknown agents are rejected", async () => {
		box = await sandbox();
		await addAgent("a");
		await cli("init");
		await expect(cli("agents", "archive", "../x")).rejects.toThrow(/invalid agent name/);
		await expect(cli("agents", "archive", "nope")).rejects.toThrow(/unknown agent "nope"/);
		await expect(cli("agents", "restore", "a")).rejects.toThrow(/is not archived/);
	});
});
