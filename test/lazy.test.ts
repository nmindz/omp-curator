import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDormantIndex, resolveSkillUrl } from "../src/dormant.ts";
import { exists, writeJsonAtomic } from "../src/fsutil.ts";
import { dormantRedirect, fallbackRead, formatSearch, hintFor, invocationMessage, SKILL_INVOCATION_TYPE } from "../src/lazy.ts";
import { loadConfig } from "../src/store.ts";
import { DAY, daysAgo, ompToolCall, sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

async function dormant(names: Record<string, string>, active: Record<string, string> = {}): Promise<Sandbox> {
	const sb = await sandbox();
	for (const [name, description] of Object.entries({ ...names, ...active })) await sb.addSkill(name, { description, createdDaysAgo: 200 });
	const curator = await sb.open();
	await curator.run("user", { allowArchive: false });
	for (const name of Object.keys(names)) await curator.archive(name, "test", "user");
	return sb;
}

describe("skill:// resolution", () => {
	const base = (name: string) => (name === "kube" ? "/arch/kube" : undefined);

	test("subpaths and read selectors map into the skill directory", () => {
		expect(resolveSkillUrl("skill://kube", base)).toEqual({ name: "kube", path: "/arch/kube/SKILL.md" });
		expect(resolveSkillUrl("skill://kube:10-40", base)?.path).toBe("/arch/kube/SKILL.md:10-40");
		expect(resolveSkillUrl("skill://kube/references/helm.md:5", base)?.path).toBe("/arch/kube/references/helm.md:5");
		expect(resolveSkillUrl("skill://ops/kube/x.md", base)?.path).toBe("/arch/kube/x.md");
	});

	test("unknown skills and paths escaping the skill directory are not resolved", () => {
		expect(resolveSkillUrl("skill://other", base)).toBeUndefined();
		expect(resolveSkillUrl("skill://kube/../../etc/passwd", base)).toBeUndefined();
		expect(resolveSkillUrl("/arch/kube/SKILL.md", base)).toBeUndefined();
	});

	test("only dormant skills are redirected, and only while lazyLoad is on", async () => {
		box = await dormant({ kube: "Kubernetes clusters." }, { jj: "Jujutsu VCS." });
		const curator = await box.open();
		const target = dormantRedirect(curator, "skill://kube:1-5");
		expect(target?.path).toBe(`${curator.state.skills.kube!.archive!.path}/SKILL.md:1-5`);
		expect(await readFile(target!.path.replace(/:[^/]*$/, ""), "utf8")).toContain("Kubernetes clusters.");
		expect(dormantRedirect(curator, "skill://jj")).toBeUndefined();

		await writeJsonAtomic(box.paths.configPath, { lazyLoad: false });
		expect(dormantRedirect(await box.open(), "skill://kube")).toBeUndefined();
	});

	test("a skill restored during a session is read from the store", async () => {
		box = await dormant({ kube: "Kubernetes clusters." });
		const curator = await box.open();
		await curator.restore("kube", "user");
		expect((await fallbackRead(curator, "skill://kube"))?.text).toContain("Kubernetes clusters.");
		expect(await fallbackRead(curator, "skill://missing")).toBeUndefined();
	});
});

describe("dormant search and hints", () => {
	const library = {
		kubernetes: "Use for kubectl, cluster debugging and pods.",
		helm: "Use for chart templates and releases on kubernetes clusters.",
		"rust-thinking": "Deep Rust code patterns.",
	};

	test("a name match outranks a description match; terms shared by many skills count less", async () => {
		box = await dormant(library, { "go-code": "Go code review.", "ts-code": "TypeScript code review." });
		const index = await buildDormantIndex(await box.open());
		expect(index.search("kubernetes pods").map(hit => hit.skill.name)).toEqual(["kubernetes", "helm"]);
		// Among dormant skills both words match only rust-thinking; "code" is also in active skills.
		const [rare] = index.search("patterns");
		const [common] = index.search("code");
		expect(rare?.skill.name).toBe("rust-thinking");
		expect(rare!.score).toBeGreaterThan(common!.score);
	});

	test("an empty search lists every dormant skill", async () => {
		box = await dormant(library);
		const out = formatSearch(await buildDormantIndex(await box.open()), "", 10);
		for (const name of Object.keys(library)) expect(out).toContain(`- ${name}:`);
	});

	test("a hint names matching skills once per session and stays silent below the threshold", async () => {
		box = await dormant(library);
		const index = await buildDormantIndex(await box.open());
		const seen = new Set<string>();
		const hint = hintFor(index, "my kubernetes pods keep crashing", 1, seen);
		expect(hint?.names[0]).toBe("kubernetes");
		expect(hint?.text).toContain("read skill://kubernetes");
		for (const name of hint!.names) seen.add(name);
		expect(hintFor(index, "kubernetes pods again", 1, seen)?.names ?? []).not.toContain("kubernetes");
		expect(hintFor(index, "kubernetes", 1_000, new Set())).toBeUndefined();
		expect(hintFor(index, "write a haiku about tea", 1, new Set())).toBeUndefined();
		expect(hintFor(index, "read skill://kubernetes about pods", 1, new Set())?.names ?? []).not.toContain("kubernetes");
	});
});

describe("lazy-load usage", () => {
	test("reads of the archived copy and /skill: invocations count as uses of the dormant skill", async () => {
		box = await dormant({ kube: "Kubernetes clusters." });
		const archived = (await box.open()).state.skills.kube!.archive!.path;
		box.clock.now = new Date(box.clock.now.getTime() + DAY);
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [
			ompToolCall(daysAgo(box.clock, 0.5), "read", { path: `${archived}/SKILL.md:1-20` }),
			{ type: "custom_message", customType: SKILL_INVOCATION_TYPE, display: true, timestamp: daysAgo(box.clock, 0.4), details: { name: "kube" } },
		]);
		const curator = await box.open();
		await curator.scan();
		expect(curator.usage.events.filter(event => event.skill === "kube").map(event => event.kind).sort()).toEqual(["command", "read"]);
	});

	test("the invocation message carries the skill body and its directory", async () => {
		box = await dormant({ kube: "Kubernetes clusters." });
		const curator = await box.open();
		const message = await invocationMessage(curator, "kube", "fix my pod");
		expect(message?.content).toContain(`[Skill directory: ${curator.state.skills.kube!.archive!.path}]`);
		expect(message?.content).toContain("User: fix my pod");
		expect(message?.content).not.toContain("description:");
		expect(await invocationMessage(curator, "missing", "")).toBeUndefined();
	});
});

describe("promotion and maxActive", () => {
	async function lazyLoads(name: string, count: number, daysBeforeNow: number) {
		const archived = (await box.open()).state.skills[name]!.archive!.path;
		await box.writeJsonl(
			join(box.paths.sessionsDir, "p", `${name}-${count}-${daysBeforeNow}.jsonl`),
			Array.from({ length: count }, () => ompToolCall(daysAgo(box.clock, daysBeforeNow), "read", { path: `${archived}/SKILL.md` })),
		);
	}

	test("a dormant skill loaded promoteAfterUses times is restored by the next pass; a dry run moves nothing", async () => {
		box = await dormant({ kube: "Kubernetes clusters.", helm: "Helm charts." });
		box.clock.now = new Date(box.clock.now.getTime() + 3 * DAY);
		await lazyLoads("kube", 2, 1);
		await lazyLoads("helm", 1, 1);

		const dry = await (await box.open()).run("user", { dryRun: true });
		expect(dry.transitions).toContainEqual(expect.objectContaining({ name: "kube", from: "archived", to: "active" }));
		expect(await exists(join(box.paths.skillsDir, "kube"))).toBe(false);

		const report = await (await box.open()).run("user");
		expect(report.transitions.filter(t => t.from === "archived").map(t => t.name)).toEqual(["kube"]);
		const curator = await box.open();
		expect(curator.state.skills.kube!.state).toBe("active");
		expect(curator.state.skills.helm!.state).toBe("archived");
		expect(await exists(join(box.paths.skillsDir, "kube", "SKILL.md"))).toBe(true);
		// The restore resets the floor: the promoted skill is not archived again by the same pass.
		expect((await curator.assess()).find(item => item.name === "kube")?.status).toBe("active");
	});

	test("loads before the skill was archived do not promote it", async () => {
		box = await sandbox();
		await box.addSkill("kube", { createdDaysAgo: 200 });
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "old.jsonl"), [
			ompToolCall(daysAgo(box.clock, 10), "read", { path: "skill://kube" }),
			ompToolCall(daysAgo(box.clock, 9), "read", { path: "skill://kube" }),
		]);
		const curator = await box.open();
		await curator.run("user", { allowArchive: false });
		await curator.archive("kube", "test", "user");
		const report = await (await box.open()).run("user");
		expect(report.transitions.some(t => t.name === "kube" && t.to === "active")).toBe(false);
	});

	test("maxActive archives the least used eligible skills, never protected ones or those in grace", async () => {
		box = await sandbox();
		for (const name of ["busy", "quiet", "unused", "pinned"]) await box.addSkill(name, { createdDaysAgo: 60 });
		await box.addSkill("fresh", { createdDaysAgo: 2 });
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [
			...Array.from({ length: 5 }, () => ompToolCall(daysAgo(box.clock, 3), "read", { path: "skill://busy" })),
			ompToolCall(daysAgo(box.clock, 3), "read", { path: "skill://quiet" }),
		]);
		const curator = await box.open();
		await curator.run("user", { allowArchive: false });
		await curator.setPinned("pinned", true, "user");
		await writeJsonAtomic(box.paths.configPath, { maxActive: 3 });

		const report = await (await box.open()).run("user");
		const archived = report.transitions.filter(t => t.to === "archived").map(t => t.name).sort();
		expect(archived).toEqual(["quiet", "unused"]);
	});
});

test("retired config keys are dropped on load", async () => {
	box = await sandbox();
	await writeJsonAtomic(box.paths.configPath, { autoRestoreOnRead: false, maxActive: 7 });
	const config = await loadConfig(box.paths);
	expect(config.maxActive).toBe(7);
	expect(Object.hasOwn(config, "autoRestoreOnRead")).toBe(false);
});
