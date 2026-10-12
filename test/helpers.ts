import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Curator } from "../src/curator.ts";
import { resolvePaths } from "../src/paths.ts";
import type { Paths } from "../src/paths.ts";

export interface Sandbox {
	root: string;
	paths: Paths;
	env: NodeJS.ProcessEnv;
	/** Mutable clock shared by every Curator opened through {@link Sandbox.open}. */
	clock: { now: Date };
	open(): Promise<Curator>;
	addSkill(name: string, options?: { description?: string; createdDaysAgo?: number; body?: string }): Promise<string>;
	writeJsonl(path: string, entries: unknown[]): Promise<void>;
	cleanup(): Promise<void>;
}

export const DAY = 86_400_000;

export async function sandbox(start = new Date("2026-10-12T12:00:00Z")): Promise<Sandbox> {
	const root = await mkdtemp(join(tmpdir(), "omp-curator-test-"));
	const env: NodeJS.ProcessEnv = { HOME: root, PI_CODING_AGENT_DIR: join(root, ".omp", "agent") };
	const paths = resolvePaths(env);
	await mkdir(paths.skillsDir, { recursive: true });
	const clock = { now: start };
	return {
		root,
		paths,
		env,
		clock,
		open: () => Curator.open({ paths, now: () => clock.now }),
		async addSkill(name, options = {}) {
			const dir = join(paths.skillsDir, name);
			await mkdir(dir, { recursive: true });
			const description = options.description ?? `Use for ${name} tasks.`;
			await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n\n${options.body ?? `# ${name}\n`}`);
			if (options.createdDaysAgo !== undefined) {
				const when = new Date(clock.now.getTime() - options.createdDaysAgo * DAY);
				await utimes(dir, when, when);
			}
			return dir;
		},
		async writeJsonl(path, entries) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, entries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
		},
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

/** OMP assistant message carrying one tool call. */
export function ompToolCall(at: string, name: string, args: Record<string, unknown>, id: string = crypto.randomUUID()) {
	return {
		type: "message",
		id,
		timestamp: at,
		message: { role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name, arguments: args }] },
	};
}

export function daysAgo(clock: { now: Date }, days: number): string {
	return new Date(clock.now.getTime() - days * DAY).toISOString();
}
