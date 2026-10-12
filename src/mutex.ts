import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Paths } from "./paths.ts";

export class MutexBusyError extends Error {}

function ownerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Serialize state mutations across processes: the CLI, and the OMP extension running in
 * every open session, share one curator directory. A lock is broken only when its owner
 * process is gone, and released only by the invocation that took it.
 */
export async function withMutex<T>(paths: Paths, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
	const lockPath = join(paths.curatorDir, "curator.lock");
	const token = `${process.pid} ${randomUUID()}`;
	await mkdir(paths.curatorDir, { recursive: true });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(token);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = await readFile(lockPath, "utf8").catch(() => "");
			const pid = Number(holder.split(" ")[0]);
			if (holder && Number.isInteger(pid) && pid > 0 && !ownerAlive(pid)) {
				// Compare-and-delete: only remove the dead owner's lock, not one taken since.
				if ((await readFile(lockPath, "utf8").catch(() => "")) === holder) await rm(lockPath, { force: true });
				continue;
			}
			if (Date.now() >= deadline) {
				throw new MutexBusyError(`omp-curator is busy (lock held by pid ${pid || "?"}: ${lockPath})`);
			}
			await sleep(200);
		}
	}
	try {
		return await fn();
	} finally {
		if ((await readFile(lockPath, "utf8").catch(() => "")) === token) await rm(lockPath, { force: true });
	}
}
