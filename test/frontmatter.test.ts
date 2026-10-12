import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
	test("plain, quoted and escaped scalars", () => {
		const meta = parseFrontmatter(
			`---\nname: jj\ndescription: "Use when \\"jj\\" exists: commit, push"\nlicense: 'It''s MIT'\nhide: true\n---\nbody`,
		);
		expect(meta).toEqual({ name: "jj", description: 'Use when "jj" exists: commit, push', license: "It's MIT", hide: true });
	});

	test("folded and literal block scalars", () => {
		const meta = parseFrontmatter(`---\nname: x\ndescription: >\n  Start HERE when unsure.\n  One hop.\nnotes: |\n  line one\n  line two\nnext: y\n---\n`);
		expect(meta?.description).toBe("Start HERE when unsure. One hop.");
		expect(meta?.notes).toBe("line one\nline two");
		expect(meta?.next).toBe("y");
	});

	test("inline and block lists (agent autoloadSkills)", () => {
		expect(parseFrontmatter(`---\nautoloadSkills: [build, "plan"]\n---\n`)?.autoloadSkills).toEqual(["build", "plan"]);
		expect(parseFrontmatter(`---\nautoload-skills:\n  - explore\n  - debugging\nmodel: x\n---\n`)?.["autoload-skills"]).toEqual([
			"explore",
			"debugging",
		]);
	});

	test("nested maps do not leak into top-level keys", () => {
		const meta = parseFrontmatter(`---\nname: a\nmetadata:\n  author: someone\n  version: "1.0"\ndescription: d\n---\n`);
		expect(meta).toEqual({ name: "a", description: "d" });
	});

	test("missing frontmatter", () => {
		expect(parseFrontmatter("# just markdown")).toBeUndefined();
	});
});
