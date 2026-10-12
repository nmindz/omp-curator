/**
 * omp-curator OMP extension. Active skills sit in the store and OMP lists them in every
 * prompt; dormant (archived) skills stay out of the prompt but load on demand:
 *   - `read skill://<dormant>` is redirected to the archived copy (selectors and subpaths work);
 *   - prompts matching a dormant skill get a one-time hidden hint;
 *   - the `skill_search` tool finds dormant skills; `/skill:<dormant>` and `/curator load` inject one.
 * It also runs the lifecycle pass in the background once per `intervalHours` and exposes the
 * CLI as `/curator <command>`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { stat } from "node:fs/promises";
import { HELP, runCli } from "./cli.ts";
import { Curator } from "./curator.ts";
import { buildDormantIndex } from "./dormant.ts";
import type { DormantIndex } from "./dormant.ts";
import { HINT_TYPE, SKILL_INVOCATION_TYPE, dormantRedirect, fallbackRead, formatSearch, hintFor, invocationMessage } from "./lazy.ts";
import { MutexBusyError, withMutex } from "./mutex.ts";
import { resolvePaths } from "./paths.ts";

const MESSAGE_TYPE = "omp-curator";
const START_DELAY_MS = 5_000;
const COMMANDS = ["load", ...(HELP.match(/^ {2}([a-z-]+)/gm)?.map(line => line.trim()) ?? [])];
const SKILL_COMMAND_RE = /^\/skill:([^\s/]+)(?:\s+([\s\S]*))?$/;

function splitArgs(input: string): string[] {
	return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(arg => arg.replace(/^(["'])(.*)\1$/, "$2"));
}

interface Snapshot {
	key: string;
	curator: Curator;
	index?: DormantIndex;
}

let snapshot: Snapshot | undefined;

/** Curator state, reloaded only when config, state or the store changed since the last call. */
async function current(): Promise<Snapshot> {
	const paths = resolvePaths();
	const stamps = await Promise.all([paths.configPath, paths.statePath, paths.skillsDir].map(path => stat(path).then(info => info.mtimeMs).catch(() => 0)));
	const key = stamps.join(":");
	if (snapshot?.key !== key) snapshot = { key, curator: await Curator.open({ paths }) };
	return snapshot;
}

async function dormantIndex(): Promise<{ curator: Curator; index: DormantIndex }> {
	const snap = await current();
	snap.index ??= await buildDormantIndex(snap.curator);
	return { curator: snap.curator, index: snap.index };
}

async function autoPass(): Promise<string | undefined> {
	const probe = await Curator.open();
	// Never act before `omp-curator init`, and defer the first pass by one interval.
	if (!probe.state.initializedAt || !probe.isDue()) return undefined;
	return withMutex(
		probe.paths,
		async () => {
			const curator = await Curator.open();
			if (!curator.isDue()) return undefined;
			const report = await curator.run("extension");
			const archived = report.transitions.filter(t => t.to === "archived").map(t => t.name);
			const promoted = report.transitions.filter(t => t.from === "archived" && t.to === "active").map(t => t.name);
			const stale = report.transitions.filter(t => t.to === "stale").map(t => t.name);
			const parts = [
				archived.length ? `dormant ${archived.join(", ")}` : "",
				promoted.length ? `active again ${promoted.join(", ")}` : "",
				stale.length ? `stale ${stale.join(", ")}` : "",
			].filter(Boolean);
			return parts.length ? parts.join("; ") : undefined;
		},
		0,
	);
}

export default function ompCurator(pi: ExtensionAPI): void {
	/** Dormant skills already hinted, per session. */
	const hinted = new Map<string, Set<string>>();

	async function inject(name: string, args: string): Promise<boolean> {
		const { curator } = await current();
		const message = await invocationMessage(curator, name, args);
		if (!message) return false;
		pi.sendMessage({ customType: SKILL_INVOCATION_TYPE, content: message.content, display: true, details: message.details }, { triggerTurn: true });
		return true;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind !== "main") return;
		ctx.setTimeout(async () => {
			try {
				const summary = await autoPass();
				if (summary && ctx.hasUI) ctx.ui.notify(`omp-curator: ${summary}`, "info");
			} catch (error) {
				// Another session is already running the pass.
				if (error instanceof MutexBusyError) return;
				if (ctx.hasUI) ctx.ui.notify(`omp-curator: automatic pass failed: ${(error as Error).message}`, "warning");
			}
		}, START_DELAY_MS);
	});

	pi.on("tool_call", async event => {
		if (event.toolName !== "read") return undefined;
		const path = event.input.path;
		if (typeof path !== "string" || !path.startsWith("skill://")) return undefined;
		try {
			const target = dormantRedirect((await current()).curator, path);
			if (!target) return undefined;
			return {
				input: { ...event.input, path: target.path },
				additionalContext: `omp-curator: "${target.name}" is a dormant skill (not in your skill list because it is rarely used); it was read from its archived copy. Resolve its relative paths against ${target.path.replace(/\/[^/]*$/, "")}.`,
			};
		} catch {
			return undefined;
		}
	});

	pi.on("tool_result", async event => {
		if (event.toolName !== "read" || !event.isError) return undefined;
		const path = event.input.path;
		if (typeof path !== "string" || !path.startsWith("skill://")) return undefined;
		try {
			const read = await fallbackRead((await current()).curator, path);
			if (!read) return undefined;
			return {
				content: [{ type: "text" as const, text: read.text }],
				isError: false,
				additionalContext: `omp-curator: "${read.name}" was restored or installed after this session started, so it was read directly from disk.`,
			};
		} catch {
			return undefined;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const { curator, index } = await dormantIndex();
			if (!curator.config.lazyLoad || !curator.config.hints || index.skills.length === 0) return undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			const seen = hinted.get(sessionId) ?? new Set<string>();
			hinted.set(sessionId, seen);
			const hint = hintFor(index, event.prompt, curator.config.hintMinScore, seen);
			if (!hint) return undefined;
			for (const name of hint.names) seen.add(name);
			return { message: { customType: HINT_TYPE, content: hint.text, display: false } };
		} catch {
			return undefined;
		}
	});

	pi.on("input", async event => {
		const match = SKILL_COMMAND_RE.exec(event.text.trim());
		if (!match) return undefined;
		try {
			return (await inject(match[1]!, match[2] ?? "")) ? { handled: true } : undefined;
		} catch {
			return undefined;
		}
	});

	pi.registerTool({
		name: "skill_search",
		label: "Skill search",
		description:
			"Search dormant skills: skills omp-curator keeps out of your skill list because they are rarely used. They still load with the read tool (read skill://<name>). Use when a task needs domain knowledge none of your listed skills cover. An empty query lists every dormant skill.",
		parameters: pi.zod.object({
			query: pi.zod.string().describe("Keywords describing the task or domain, e.g. 'kubernetes helm deploy'"),
			limit: pi.zod.number().int().min(1).max(50).optional().describe("Maximum results (default 8)"),
		}),
		approval: "read",
		async execute(_toolCallId, params) {
			const { index } = await dormantIndex();
			return { content: [{ type: "text", text: formatSearch(index, params.query, params.limit ?? 8) }], details: {} };
		},
	});

	pi.registerCommand("curator", {
		description: "Skill usage and lifecycle (omp-curator): status, list, search, load <skill>, archive, restore, run, …",
		getArgumentCompletions: prefix =>
			COMMANDS.filter(command => command.startsWith(prefix.trim())).map(command => ({ value: command, label: command })),
		handler: async args => {
			const [command, name, ...rest] = splitArgs(args);
			if (command === "load" && name) {
				if (await inject(name, rest.join(" "))) return;
				pi.sendMessage({ customType: MESSAGE_TYPE, content: `omp-curator: "${name}" is not a dormant skill.`, display: true });
				return;
			}
			let text: string;
			try {
				text = (await runCli(splitArgs(args))).out;
			} catch (error) {
				text = `omp-curator: ${(error as Error).message}`;
			}
			pi.sendMessage({ customType: MESSAGE_TYPE, content: `\`\`\`text\n${text}\n\`\`\``, display: true });
		},
	});
}
