import { createHash } from "node:crypto";
import { appendFile, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
	}
}

/** Write via a sibling temp file and rename, so readers never see a partial file. */
export async function writeJsonAtomic(path: string, data: unknown, indent = 2): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data, null, indent)}\n`, "utf8");
	await rename(tmp, path);
}

export async function appendJsonLine(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(data)}\n`, "utf8");
}

/**
 * Move a skill entry. A symlink is re-created as an absolute link at the destination
 * (a relative target would dangle after the move) instead of being renamed.
 */
export async function moveEntry(src: string, dest: string): Promise<void> {
	await mkdir(dirname(dest), { recursive: true });
	const info = await lstat(src);
	if (info.isSymbolicLink()) {
		const target = resolve(dirname(src), await readlink(src));
		await symlink(target, dest);
		await rm(src);
		return;
	}
	try {
		await rename(src, dest);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(src, dest, { recursive: true, verbatimSymlinks: true });
		await rm(src, { recursive: true, force: true });
	}
}

/** Stable digest of a directory tree's relative paths and file bytes (symlinks followed). */
export async function hashTree(root: string): Promise<string> {
	const hash = createHash("sha256");
	async function walk(dir: string, rel: string): Promise<void> {
		const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name === ".DS_Store") continue;
			const abs = join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			const info = await stat(abs);
			if (info.isDirectory()) {
				await walk(abs, relPath);
			} else {
				hash.update(relPath);
				hash.update("\0");
				hash.update(await readFile(abs));
				hash.update("\0");
			}
		}
	}
	await walk(root, "");
	return hash.digest("hex");
}

/** Whole days elapsed since `fromIso`. */
export function daysBetween(fromIso: string, to: Date): number {
	return Math.floor((to.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

/** Filesystem-safe timestamp used to disambiguate archive, backup, and conflict entries. */
export function stamp(now = new Date()): string {
	return now.toISOString().replace(/[:.]/g, "-");
}
