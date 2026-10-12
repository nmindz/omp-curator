import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../src/fsutil.ts";
import { vercelIntegration } from "../src/integrations/vercel/index.ts";
import { findStrayLinks, linkAgentsDir, linkStatus, unlinkAgentsDir } from "../src/integrations/vercel/link.ts";
import { readLock, writeLock } from "../src/integrations/vercel/lock.ts";
import type { SkillLockEntry } from "../src/integrations/vercel/lock.ts";
import { folderHashFromTree, installSource, trackSkill, updateSkills } from "../src/integrations/vercel/remote.ts";
import type { GithubTree, RemoteDeps } from "../src/integrations/vercel/remote.ts";
import { resolvePaths } from "../src/paths.ts";
import { sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

async function skillDir(root: string, name: string, body = "x"): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}`);
	return dir;
}

describe("~/.agents/skills link", () => {
	test("migrates entries: unique moved, identical dropped, differing parked; idempotent", async () => {
		box = await sandbox();
		await skillDir(box.paths.skillsDir, "same");
		await skillDir(box.paths.skillsDir, "differs", "store copy");
		await skillDir(box.paths.agentsSkillsDir, "same");
		await skillDir(box.paths.agentsSkillsDir, "differs", "agents copy");
		await skillDir(box.paths.agentsSkillsDir, "unique");
		await writeFile(join(box.paths.agentsSkillsDir, ".ripwire-manifest-v1"), "version=1\n");
		const vendor = await skillDir(join(box.root, "vendor"), "linked");
		await symlink(vendor, join(box.paths.skillsDir, "linked"));
		await symlink(vendor, join(box.paths.agentsSkillsDir, "linked"));

		const dry = await linkAgentsDir(box.paths, true);
		expect((await linkStatus(box.paths)).kind).toBe("directory");
		const report = await linkAgentsDir(box.paths, false);
		expect(dry).toMatchObject({ moved: report.moved, duplicates: report.duplicates });
		expect(report.moved).toEqual([".ripwire-manifest-v1", "unique"]);
		expect(report.duplicates).toEqual(["linked", "same"]);
		expect(report.conflicts.map(c => c.name)).toEqual(["differs"]);
		expect(await readFile(join(report.conflicts[0]!.keptAt, "SKILL.md"), "utf8")).toContain("agents copy");
		expect(await readFile(join(box.paths.skillsDir, "differs", "SKILL.md"), "utf8")).toContain("store copy");
		expect((await linkStatus(box.paths)).kind).toBe("linked");
		expect(await readlink(box.paths.agentsSkillsDir)).toBe(box.paths.skillsDir);
		expect(await exists(join(box.paths.agentsSkillsDir, "unique", "SKILL.md"))).toBe(true);
		expect((await linkAgentsDir(box.paths, false)).before).toBe("linked");

		await unlinkAgentsDir(box.paths);
		expect((await lstat(box.paths.agentsSkillsDir)).isDirectory()).toBe(true);
		expect(await exists(join(box.paths.skillsDir, "unique"))).toBe(true);
	});

	test("refuses a link that points elsewhere", async () => {
		box = await sandbox();
		await mkdir(join(box.root, ".agents"), { recursive: true });
		await mkdir(join(box.root, "elsewhere"));
		await symlink(join(box.root, "elsewhere"), box.paths.agentsSkillsDir);
		await expect(linkAgentsDir(box.paths, false)).rejects.toThrow(/links to/);
	});

	test("stray harness links into the store are found and fixed", async () => {
		box = await sandbox();
		await skillDir(box.paths.skillsDir, "s");
		await linkAgentsDir(box.paths, false);
		const claudeSkills = join(box.root, ".claude", "skills");
		await mkdir(claudeSkills, { recursive: true });
		await symlink("../../.agents/skills/s", join(claudeSkills, "s"));
		await skillDir(claudeSkills, "own");
		expect((await findStrayLinks(box.paths)).map(stray => stray.path)).toEqual([join(claudeSkills, "s")]);
		const ctx = { paths: box.paths, config: (await box.open()).config };
		expect((await vercelIntegration.doctor!(ctx)).filter(f => f.level === "warn")).toHaveLength(1);
		await vercelIntegration.fix!(ctx);
		expect(await exists(join(claudeSkills, "s"))).toBe(false);
		expect(await exists(join(claudeSkills, "own"))).toBe(true);
	});

	test("a harness skills dir left empty by the fix is removed", async () => {
		box = await sandbox();
		await skillDir(box.paths.skillsDir, "s");
		await linkAgentsDir(box.paths, false);
		const geminiSkills = join(box.root, ".gemini", "skills");
		await mkdir(geminiSkills, { recursive: true });
		await symlink(join(box.paths.agentsSkillsDir, "s"), join(geminiSkills, "s"));
		const changes = await vercelIntegration.fix!({ paths: box.paths, config: (await box.open()).config });
		expect(changes).toEqual([`removed ${join(geminiSkills, "s")}`, `removed empty ${geminiSkills}`]);
		expect(await exists(geminiSkills)).toBe(false);
	});
});

describe("lock file", () => {
	test("pre-v3 locks read as empty; unknown fields survive round trips", async () => {
		box = await sandbox();
		await mkdir(join(box.root, ".agents"), { recursive: true });
		await writeFile(box.paths.lockPath, JSON.stringify({ version: 2, skills: { a: {} } }));
		expect((await readLock(box.paths)).skills).toEqual({});
		await writeLock(box.paths, { version: 3, skills: {}, dismissed: { findSkillsPrompt: true } });
		expect((await readLock(box.paths)).dismissed).toEqual({ findSkillsPrompt: true });
	});

	test("XDG_STATE_HOME relocates the lock like the skills CLI does", () => {
		expect(resolvePaths({ HOME: "/h", XDG_STATE_HOME: "/state" }).lockPath).toBe("/state/skills/.skill-lock.json");
		expect(resolvePaths({ HOME: "/h" }).lockPath).toBe("/h/.agents/.skill-lock.json");
	});
});

const entry = (overrides: Partial<SkillLockEntry> = {}): SkillLockEntry => ({
	source: "acme/skills",
	sourceType: "github",
	sourceUrl: "https://github.com/acme/skills.git",
	skillPath: "skills/one/SKILL.md",
	skillFolderHash: "1".repeat(40),
	installedAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	...overrides,
});

describe("update", () => {
	test("source strings match the skills CLI", () => {
		expect(installSource(entry())).toBe("acme/skills/skills/one");
		expect(installSource(entry({ ref: "v2" }))).toBe("acme/skills/skills/one#v2");
		expect(installSource(entry({ skillPath: "SKILL.md" }))).toBe("acme/skills");
		expect(installSource(entry({ sourceType: "git", source: "acme/x", sourceUrl: "git@host:acme/x.git" }))).toBe("git@host:acme/x.git");
	});

	test("folder hash lookup", () => {
		const tree: GithubTree = { sha: "root", tree: [{ path: "skills/one", type: "tree", sha: "abc" }] };
		expect(folderHashFromTree(tree, "skills/one/SKILL.md")).toBe("abc");
		expect(folderHashFromTree(tree, "SKILL.md")).toBe("root");
		expect(folderHashFromTree(tree, "skills/two/SKILL.md")).toBeUndefined();
	});

	test("checks each tree once, reinstalls only changed skills with -a pi", async () => {
		box = await sandbox();
		await writeLock(box.paths, {
			version: 3,
			skills: {
				one: entry(),
				two: entry({ skillPath: "skills/two/SKILL.md", skillFolderHash: "2".repeat(40) }),
				local: entry({ sourceType: "local", skillFolderHash: "" }),
				gone: entry({ skillPath: "skills/gone/SKILL.md" }),
			},
		});
		const calls: string[][] = [];
		let fetches = 0;
		const deps: RemoteDeps = {
			run: (_command, args) => {
				calls.push(args);
				return { ok: true, output: "" };
			},
			fetchTree: async () => {
				fetches++;
				return { sha: "r", tree: [{ path: "skills/one", type: "tree", sha: "1".repeat(40) }, { path: "skills/two", type: "tree", sha: "f".repeat(40) }] };
			},
		};
		const active = new Set(["one", "two", "local"]);
		const dry = await updateSkills(box.paths, "skills", { dryRun: true, active }, deps);
		expect(dry.map(item => `${item.name}:${item.status}`)).toEqual(["gone:skipped", "local:skipped", "one:current", "two:outdated"]);
		expect(calls).toEqual([]);
		// A real install would land outside OMP until ~/.agents/skills is the store link.
		await expect(updateSkills(box.paths, "skills", { dryRun: false, active }, deps)).rejects.toThrow(/not linked/);
		await linkAgentsDir(box.paths, false);
		const real = await updateSkills(box.paths, "skills", { dryRun: false, active, names: ["two"] }, deps);
		expect(real).toEqual([{ name: "two", status: "updated", detail: undefined }]);
		expect(calls).toEqual([["add", "acme/skills/skills/two", "--skill", "two", "-g", "-a", "pi", "-y"]]);
		expect(fetches).toBe(2);
	});

	test("track requires the link, backs up readable content and requires a lock entry", async () => {
		box = await sandbox();
		const vendor = await skillDir(join(box.root, "vendor"), "mine", "local edits");
		await symlink("../../../vendor/mine", join(box.paths.skillsDir, "mine"));
		const run: RemoteDeps = { run: () => ({ ok: true, output: "installed" }), fetchTree: async () => undefined };
		await expect(trackSkill(box.paths, "skills", "mine", "acme/skills", run)).rejects.toThrow(/not linked/);
		await linkAgentsDir(box.paths, false);
		await expect(trackSkill(box.paths, "skills", "mine", "acme/skills", run)).rejects.toThrow(/no lock entry/);
		await writeLock(box.paths, { version: 3, skills: { mine: entry() } });
		const result = await trackSkill(box.paths, "skills", "mine", "acme/skills", run);
		// The backup of a relatively-linked skill is real content, not a link that dangles from backups/.
		expect((await lstat(result.backup!)).isSymbolicLink()).toBe(false);
		expect(await readFile(join(result.backup!, "SKILL.md"), "utf8")).toContain("local edits");
		expect(await exists(vendor)).toBe(true);
	});
});
