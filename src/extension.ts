/**
 * omp-curator OMP extension:
 *   - runs the usage scan + lifecycle pass in the background when `intervalHours` elapsed;
 *   - restores an archived skill the moment an agent tries to read it through `skill://`;
 *   - exposes the CLI as `/curator <command>`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { HELP, runCli } from "./cli.ts";
import { Curator } from "./curator.ts";
import { MutexBusyError, withMutex } from "./mutex.ts";
import { skillFromUrl } from "./usage/jsonl.ts";

const MESSAGE_TYPE = "omp-curator";
const START_DELAY_MS = 5_000;
const COMMANDS = HELP.match(/^ {2}([a-z-]+)/gm)?.map(line => line.trim()) ?? [];

function splitArgs(input: string): string[] {
	return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(arg => arg.replace(/^(["'])(.*)\1$/, "$2"));
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
			const stale = report.transitions.filter(t => t.to === "stale").map(t => t.name);
			if (!archived.length && !stale.length) return undefined;
			return [
				archived.length ? `archived ${archived.join(", ")}` : "",
				stale.length ? `stale ${stale.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("; ");
		},
		0,
	);
}

/** Restore the archived skill a failed `skill://` read asked for; returns guidance for the agent. */
async function restoreOnRead(url: string): Promise<string | undefined> {
	const curator = await Curator.open();
	const known = new Set(Object.keys(curator.state.skills));
	for (const record of Object.values(curator.state.skills)) if (record.registeredName) known.add(record.registeredName);
	const requested = skillFromUrl(url, known);
	const key = requested && curator.resolveName(requested);
	if (!key || curator.state.skills[key]?.state !== "archived") return undefined;
	const archive = curator.state.skills[key]!.archive;
	if (!curator.config.autoRestoreOnRead) {
		return `omp-curator archived the skill "${requested}" (${archive?.reason ?? "unused"}). Restore it with \`omp-curator restore ${key}\`, or read the archived copy at ${archive?.path}/SKILL.md.`;
	}
	const restored = await withMutex(curator.paths, async () => {
		await curator.reload();
		// Another session may have restored it while this one waited for the mutex.
		if (curator.state.skills[key]?.state !== "archived") return join(curator.paths.skillsDir, key);
		return curator.restore(key, "extension");
	});
	return `omp-curator had archived the skill "${requested}" and restored it because it was requested. \`skill://${requested}\` resolves again from the next session; read it now at ${join(restored, "SKILL.md")}.`;
}

export default function ompCurator(pi: ExtensionAPI): void {
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

	pi.on("tool_result", async event => {
		if (event.toolName !== "read" || !event.isError) return undefined;
		const path = event.input.path;
		if (typeof path !== "string" || !path.startsWith("skill://")) return undefined;
		try {
			const note = await restoreOnRead(path);
			return note ? { additionalContext: note } : undefined;
		} catch {
			return undefined;
		}
	});

	pi.registerCommand("curator", {
		description: "Skill usage and lifecycle (omp-curator): status, list, archive, restore, run, …",
		getArgumentCompletions: prefix =>
			COMMANDS.filter(command => command.startsWith(prefix.trim())).map(command => ({ value: command, label: command })),
		handler: async args => {
			let text: string;
			try {
				const result = await runCli(splitArgs(args));
				text = result.out;
			} catch (error) {
				text = `omp-curator: ${(error as Error).message}`;
			}
			pi.sendMessage({ customType: MESSAGE_TYPE, content: `\`\`\`text\n${text}\n\`\`\``, display: true });
		},
	});
}
