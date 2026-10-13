import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { exists } from "../src/fsutil.ts";
import { openTokenizer } from "../src/tokens.ts";
import { daysAgo, ompToolCall, sandbox } from "./helpers.ts";
import type { Sandbox } from "./helpers.ts";

let box: Sandbox;
const realFetch = globalThis.fetch;
afterEach(async () => {
	globalThis.fetch = realFetch;
	await box?.cleanup();
});

/** A byte-level vocabulary (one token per byte), so counts equal UTF-8 byte lengths. */
const BYTE_VOCAB = Array.from({ length: 256 }, (_, rank) => `${Buffer.from([rank]).toString("base64")} ${rank}`).join("\n");
const BYTE_VOCAB_SHA = new Bun.CryptoHasher("sha256").update(BYTE_VOCAB).digest("hex");

describe("tokenizer", () => {
	test("downloads the vocabulary once, verifies it and reuses the cached copy offline", async () => {
		box = await sandbox();
		let downloads = 0;
		const download = async () => (downloads++, BYTE_VOCAB);
		const first = await openTokenizer(box.paths, { download, sha256: BYTE_VOCAB_SHA });
		expect(first.exact).toBe(true);
		expect(first.count("héllo")).toBe(6);
		const second = await openTokenizer(box.paths, {
			download: async () => {
				throw new Error("offline");
			},
			sha256: BYTE_VOCAB_SHA,
		});
		expect(second.exact).toBe(true);
		expect(downloads).toBe(1);
	});

	test("a vocabulary that fails its checksum is neither cached nor used", async () => {
		box = await sandbox();
		const tokenizer = await openTokenizer(box.paths, { download: async () => BYTE_VOCAB, sha256: "0".repeat(64) });
		expect(tokenizer.exact).toBe(false);
		expect(tokenizer.warning).toContain("checksum mismatch");
		expect(tokenizer.count("hello world")).toBeGreaterThan(0);
		expect(await exists(join(box.paths.curatorDir, "vocab", "o200k_base.tiktoken"))).toBe(false);
	});
});

describe("list --tokenize", () => {
	async function library(): Promise<Sandbox> {
		const sb = await sandbox();
		await sb.addSkill("short", { description: "Tiny.", body: "x" });
		await sb.addSkill("long", { description: "Use for ".repeat(60), body: "word ".repeat(2000) });
		globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
		await (await sb.open()).run("user", { allowArchive: false });
		return sb;
	}
	const cli = (...argv: string[]) => runCli(argv, { paths: box.paths, now: () => box.clock.now });

	test("token bounds filter on the prompt entry, or the whole SKILL.md with --by body", async () => {
		box = await library();
		const names = (out: string) => out.split("\n").filter(line => /^(short|long) /.test(line)).map(line => line.split(/\s+/)[0]);
		expect(names((await cli("list", "--min-tokens=50")).out)).toEqual(["long"]);
		expect(names((await cli("list", "--max-tokens", "50")).out)).toEqual(["short"]);
		expect(names((await cli("list", "--by", "body", "--min-tokens=1000")).out)).toEqual(["long"]);
		expect((await cli("list", "--min-tokens=100000")).out).toBe("no skills match");
	});

	test("the summary totals the listed skills and flags estimates", async () => {
		box = await library();
		const out = (await cli("list", "--tokenize")).out;
		// "aaa" precedes "long" by name, so only the token order puts "long" first.
		await box.addSkill("aaa", { description: "A.", body: "x" });
		await (await box.open()).run("user", { allowArchive: false });
		const sorted = (await cli("list", "--sort", "prompt-tok")).out;
		expect(sorted.indexOf("\nlong ")).toBeLessThan(sorted.indexOf("\naaa "));
		// --asc reverses the default (largest first) direction; --sort on a token column implies --tokenize.
		const ascending = (await cli("list", "--sort", "skillmd-tok", "--asc")).out;
		expect(ascending.indexOf("\nlong ")).toBeGreaterThan(ascending.indexOf("\naaa "));
		expect(ascending).toContain("SKILL.md tok");
		expect(out).toMatch(/2 skill\(s\) · prompt \d+ tokens \(avg \d+\) · SKILL\.md \d+ tokens \(avg \d+\) · estimated/);
		const json = JSON.parse((await cli("list", "--tokenize", "--json")).out) as Array<{ name: string; tokens: { prompt: number; body: number } }>;
		expect(json.find(row => row.name === "long")!.tokens.body).toBeGreaterThan(json.find(row => row.name === "short")!.tokens.body);
	});

	test("invalid bounds are rejected", async () => {
		box = await library();
		await expect(cli("list", "--max-tokens=lots")).rejects.toThrow(/--max-tokens expects/);
	});

	test("several sort keys apply in order, each with its own direction; missing values sort lowest", async () => {
		box = await library();
		// "aaa" is unused like "long" but has a smaller entry; "used" has the biggest entry of all.
		await box.addSkill("aaa", { description: "A.", body: "x" });
		await box.addSkill("used", { description: "Use for ".repeat(120), body: "x" });
		await box.writeJsonl(join(box.paths.sessionsDir, "p", "s.jsonl"), [ompToolCall(daysAgo(box.clock, 1), "read", { path: "skill://used" })]);
		await (await box.open()).run("user", { allowArchive: false });
		const order = async (...argv: string[]) =>
			(JSON.parse((await cli("list", "--json", ...argv)).out) as Array<{ name: string }>).map(row => row.name).filter(name => name !== "short");
		expect(await order("--sort", "last-used:asc,prompt-tok:desc")).toEqual(["long", "aaa", "used"]);
		expect(await order("--sort", "last-used:desc,prompt-tok:asc")).toEqual(["used", "aaa", "long"]);
		// --asc fills in keys without their own direction.
		expect(await order("--sort", "last-used:asc,prompt-tok", "--asc")).toEqual(["aaa", "long", "used"]);
		await expect(cli("list", "--sort", "uses:sideways")).rejects.toThrow(/invalid sort direction in "uses:sideways"/);
	});
});
