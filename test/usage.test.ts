import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aggregate } from "../src/usage/db.ts";
import { scanUsage } from "../src/usage/index.ts";
import type { UsageDb } from "../src/usage/types.ts";
import { ompToolCall, sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

const emptyDb = (): UsageDb => ({ version: 1, cursors: {}, events: [] });
const KNOWN = new Set(["jj", "herdr", "build", "explore", "frontend-design", "token-context-group"]);

describe("OMP sessions", () => {
	test("counts structured invocations only", async () => {
		box = await sandbox();
		const file = join(box.paths.sessionsDir, "-proj", "s1.jsonl");
		await box.writeJsonl(file, [
			{ type: "title", title: "x", pad: "    " },
			ompToolCall("2026-10-01T10:00:00Z", "read", { path: "skill://jj" }),
			ompToolCall("2026-10-01T10:01:00Z", "read", { path: "skill://jj/scripts/push.sh:1-20" }),
			ompToolCall("2026-10-01T10:02:00Z", "read", { path: "/Users/u/.omp/agent/skills/herdr/SKILL.md" }),
			ompToolCall("2026-10-01T10:03:00Z", "bash", { command: "cat ~/.omp/agent/skills/build/SKILL.md ~/.omp/agent/skills/build/x" }),
			{ type: "custom_message", customType: "skill-prompt", display: true, details: { name: "explore" }, timestamp: "2026-10-01T10:04:00Z" },
			{ type: "custom_message", customType: "skill-prompt", display: false, details: { name: "build" }, timestamp: "2026-10-01T10:05:00Z" },
			// Recalled memory text quoting a skill URL is not an invocation.
			{ type: "custom_message", customType: "memory", content: "First read skill://herdr before proceeding", timestamp: "2026-10-01T10:06:00Z" },
			{ type: "message", timestamp: "2026-10-01T10:07:00Z", message: { role: "user", content: "please read skill://jj" } },
		]);
		const db = emptyDb();
		const result = await scanUsage({ paths: box.paths, db, known: KNOWN }, { claude: false, opencode: false });
		expect(result.omp).toEqual({ added: 6, files: 1 });
		const usage = aggregate(db.events);
		expect(usage.get("jj")).toMatchObject({ uses: 2, byKind: { read: 2 }, lastUsed: "2026-10-01T10:01:00Z" });
		expect(usage.get("herdr")).toMatchObject({ uses: 1 });
		expect(usage.get("explore")?.byKind).toEqual({ command: 1 });
		expect(usage.get("build")).toMatchObject({ uses: 1, byKind: { autoload: 1 }, mentions: 1 });
	});

	test("namespaced skill:// resolves to the installed name", async () => {
		box = await sandbox();
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [
			ompToolCall("2026-10-01T00:00:00Z", "read", { path: "skill://my-plugin/frontend-design" }),
			ompToolCall("2026-10-01T00:00:01Z", "read", { path: "skill://frontend-design/references/x.md" }),
		]);
		const db = emptyDb();
		await scanUsage({ paths: box.paths, db, known: KNOWN }, { claude: false, opencode: false });
		expect(db.events.map(event => event.skill)).toEqual(["frontend-design", "frontend-design"]);
	});

	test("incremental: appended lines only, torn tail re-read, rewritten file rescanned", async () => {
		box = await sandbox();
		const file = join(box.paths.sessionsDir, "p", "subagent", "child.jsonl");
		await box.writeJsonl(file, [ompToolCall("2026-10-01T00:00:00Z", "read", { path: "skill://jj" })]);
		const db = emptyDb();
		const ctx = { paths: box.paths, db, known: KNOWN };
		const only = { claude: false, opencode: false };
		await scanUsage(ctx, only);
		expect((await scanUsage(ctx, only)).omp).toEqual({ added: 0, files: 0 });

		const line = JSON.stringify(ompToolCall("2026-10-02T00:00:00Z", "read", { path: "skill://herdr" }));
		await appendFile(file, line.slice(0, 40));
		expect((await scanUsage(ctx, only)).omp?.added).toBe(0);
		await appendFile(file, `${line.slice(40)}\n`);
		expect((await scanUsage(ctx, only)).omp?.added).toBe(1);
		expect(db.events.map(event => event.skill)).toEqual(["jj", "herdr"]);

		await writeFile(file, `${JSON.stringify(ompToolCall("2026-10-03T00:00:00Z", "read", { path: "skill://build" }))}\n`);
		await scanUsage(ctx, only);
		expect(db.events.map(event => event.skill)).toEqual(["build"]);
	});
});

describe("Claude Code transcripts", () => {
	test("Skill tool, SKILL.md reads and slash commands", async () => {
		box = await sandbox();
		await box.writeJsonl(join(box.paths.claudeProjectsDir, "-p", "s.jsonl"), [
			{ type: "assistant", timestamp: "2026-08-01T00:00:00Z", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "superpowers:jj" } }] } },
			{ type: "assistant", timestamp: "2026-08-02T00:00:00Z", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/h/.claude/skills/herdr/SKILL.md" } }] } },
			{ type: "user", timestamp: "2026-08-03T00:00:00Z", message: { content: "<command-name>/build</command-name>" } },
			{ type: "user", timestamp: "2026-08-04T00:00:00Z", message: { content: "<command-name>/clear</command-name>" } },
		]);
		const db = emptyDb();
		await scanUsage({ paths: box.paths, db, known: KNOWN }, { omp: false, opencode: false });
		expect(db.events.map(event => [event.skill, event.kind, event.harness])).toEqual([
			["jj", "skill-tool", "claude"],
			["herdr", "file", "claude"],
			["build", "command", "claude"],
		]);
	});
});

describe("OpenCode database", () => {
	const part = (tool: string, input: Record<string, unknown>, status = "completed") => JSON.stringify({ type: "tool", tool, state: { status, input } });
	const createDb = (path: string) => {
		const sqlite = new Database(path);
		sqlite.run("pragma journal_mode = wal");
		sqlite.run("create table part (id text primary key, session_id text, time_created integer, time_updated integer, data text)");
		return sqlite;
	};

	test("skill tool parts and SKILL.md reads, skipped when unchanged", async () => {
		box = await sandbox();
		await mkdir(dirname(box.paths.opencodeDb), { recursive: true });
		const sqlite = createDb(box.paths.opencodeDb);
		const insert = sqlite.prepare("insert into part values (?, ?, ?, ?, ?)");
		insert.run("a", "s1", 1_780_000_000_000, 1_780_000_000_000, part("skill", { name: "token-context-group" }));
		insert.run("b", "s1", 1_780_000_001_000, 1_780_000_001_000, part("read", { filePath: "/h/.config/opencode/skills/jj/SKILL.md" }));
		// A task prompt quoting `"tool":"skill"` must not count.
		insert.run("c", "s2", 1_780_000_002_000, 1_780_000_002_000, part("task", { prompt: 'call {"tool":"skill"}' }));
		// Unfinalized statements make close() lazy; the deferred checkpoint would race the scans.
		insert.finalize();
		sqlite.close();
		const db = emptyDb();
		const ctx = { paths: box.paths, db, known: KNOWN };
		expect((await scanUsage(ctx, { omp: false, claude: false })).opencode).toEqual({ added: 2, files: 1 });
		expect(db.events.map(event => [event.skill, event.kind, event.src.split("#")[1]])).toEqual([
			["token-context-group", "skill-tool", "s1"],
			["jj", "file", "s1"],
		]);
		expect((await scanUsage(ctx, { omp: false, claude: false })).opencode).toEqual({ added: 0, files: 0 });
	});

	test("a pending part updated in place later, while the writer keeps the WAL open, counts once", async () => {
		box = await sandbox();
		await mkdir(dirname(box.paths.opencodeDb), { recursive: true });
		const writer = createDb(box.paths.opencodeDb);
		const db = emptyDb();
		const ctx = { paths: box.paths, db, known: KNOWN };
		const only = { omp: false, claude: false };
		try {
			writer.prepare("insert into part values (?, ?, ?, ?, ?)").run("p", "s1", 1_000, 1_000, part("skill", {}, "pending"));
			await scanUsage(ctx, only);
			expect(db.events).toEqual([]);
			// OpenCode upserts the row with its input, keeping time_created.
			writer.prepare("update part set time_updated = ?, data = ? where id = ?").run(2_000, part("skill", { name: "jj" }), "p");
			await scanUsage(ctx, only);
			expect(db.events.map(event => [event.skill, event.at])).toEqual([["jj", new Date(1_000).toISOString()]]);
			// Later metadata updates of the same part are not counted again.
			writer.prepare("update part set time_updated = ? where id = ?").run(3_000, "p");
			await scanUsage(ctx, only);
			expect(db.events).toHaveLength(1);
		} finally {
			writer.close();
		}
	});
});

describe("JSONL rewrites", () => {
	test("a same-size or growing rewrite is detected and rescanned", async () => {
		box = await sandbox();
		const file = join(box.paths.sessionsDir, "p", "s.jsonl");
		await box.writeJsonl(file, [ompToolCall("2026-10-01T00:00:00Z", "read", { path: "skill://build" }, "fixed-id")]);
		const db = emptyDb();
		const ctx = { paths: box.paths, db, known: KNOWN };
		const only = { claude: false, opencode: false };
		await scanUsage(ctx, only);
		// Same length: "build" → "herdr" (5 chars), same id and timestamp.
		await box.writeJsonl(file, [ompToolCall("2026-10-01T00:00:00Z", "read", { path: "skill://herdr" }, "fixed-id")]);
		await scanUsage(ctx, only);
		expect(db.events.map(event => event.skill)).toEqual(["herdr"]);
	});
});

describe("aggregation", () => {
	const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
	const file = (skill: string, minute: number, src = "omp:a") => ({ skill, kind: "file" as const, at: at(minute), harness: "omp", src });

	test("bulk SKILL.md scans in one session count as mentions, not use", () => {
		const scan = ["a", "b", "c", "d", "e"].map((skill, i) => file(skill, i));
		const usage = aggregate([...scan, file("a", 200), file("f", 1, "omp:other")]);
		expect(usage.get("b")).toMatchObject({ uses: 0, mentions: 1 });
		// The same skill read on its own later is real use; other sessions are unaffected.
		expect(usage.get("a")).toMatchObject({ uses: 1, mentions: 1 });
		expect(usage.get("f")).toMatchObject({ uses: 1, mentions: 0 });
	});

	test("native skill loads are never reclassified", () => {
		const loads = ["a", "b", "c", "d", "e", "f"].map(skill => ({ skill, kind: "skill-tool" as const, at: at(0), harness: "opencode", src: "o#s" }));
		expect([...aggregate(loads).values()].every(usage => usage.uses === 1)).toBe(true);
	});
});
