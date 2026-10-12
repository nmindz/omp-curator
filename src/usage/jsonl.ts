import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ScanContext, ScanResult, UsageEvent, UsageKind } from "./types.ts";

const CHUNK_BYTES = 32 * 1024 * 1024;
const SKILL_URL_RE = /^skill:\/\/([^/:?#\s]+)(?:\/([^/:?#\s]+))?/;

/** `.../skills/<name>/SKILL.md`, optionally followed by a read selector such as `:1-40`. */
export const SKILL_MD_RE = /\/skills\/([^/\s]+)\/SKILL\.md(?::[\d+,-]*)?$/;

export type Emit = (skill: string, kind: UsageKind, at: string) => void;

export interface ParseContext {
	known: Set<string>;
	/** Curator archive root; reads of a dormant skill's files there are lazy loads. */
	archiveDir: string;
}

export interface JsonlParser {
	/** A line must contain one of these substrings before it is parsed. */
	needles: string[];
	parse(entry: Record<string, unknown>, ctx: ParseContext, emit: Emit): void;
}

/** Map `skill://name[/...]` or `skill://namespace/name` to an installed skill name. */
export function skillFromUrl(url: string, known: Set<string>): string | undefined {
	const match = SKILL_URL_RE.exec(url);
	if (!match) return undefined;
	const [, first, second] = match;
	if (known.has(first!) || !second || !known.has(second)) return first;
	return second;
}

/**
 * Skill whose archived SKILL.md a path reads (`<archiveDir>/<name>[@stamp]/SKILL.md[:sel]`).
 * The extension rewrites `skill://` reads of dormant skills to such paths.
 */
export function archivedSkillFromPath(path: string, archiveDir: string): string | undefined {
	if (!path.startsWith(`${archiveDir}/`)) return undefined;
	const match = /^([^/@]+)(?:@[^/]+)?\/SKILL\.md(?::[\w,+:-]*)?$/.exec(path.slice(archiveDir.length + 1));
	return match?.[1];
}

/** Emit one weak `mention` per known skill directory referenced by a shell command. */
export function emitMentions(command: string, known: Set<string>, at: string, emit: Emit): void {
	const seen = new Set<string>();
	for (const match of command.matchAll(/\/skills\/([\w.-]+)/g)) {
		const name = match[1]!;
		if (known.has(name) && !seen.has(name)) {
			seen.add(name);
			emit(name, "mention", at);
		}
	}
}

export function entryTime(entry: Record<string, unknown>): string | undefined {
	const raw = entry.timestamp ?? (entry.message as Record<string, unknown> | undefined)?.timestamp;
	if (typeof raw === "string") return raw;
	if (typeof raw === "number") return new Date(raw).toISOString();
	return undefined;
}

/** Files under `root` (recursively) whose name ends with `suffix`. */
export async function listFiles(root: string, suffix: string): Promise<string[]> {
	try {
		const rel = await readdir(root, { recursive: true });
		return rel.filter(path => path.endsWith(suffix)).map(path => join(root, path));
	} catch {
		return [];
	}
}

export const listJsonl = (root: string): Promise<string[]> => listFiles(root, ".jsonl");

function parseLines(text: string, parser: JsonlParser, ctx: ParseContext, emit: Emit): void {
	for (const line of text.split("\n")) {
		if (!parser.needles.some(needle => line.includes(needle))) continue;
		try {
			parser.parse(JSON.parse(line) as Record<string, unknown>, ctx, emit);
		} catch {
			// torn or non-JSON line
		}
	}
}

function emitter(ctx: ScanContext, harness: string, key: string, counter: { added: number }): Emit {
	return (skill, kind, at) => {
		ctx.db.events.push({ skill, kind, at, harness, src: key } satisfies UsageEvent);
		counter.added++;
	};
}

const sha1 = (data: Uint8Array): string => createHash("sha1").update(data).digest("hex");

/** Bytes before the cursor fingerprinted to detect rewrites that keep or grow the size. */
const TAIL_BYTES = 64;

async function readTail(handle: FileHandle, offset: number): Promise<string> {
	const length = Math.min(TAIL_BYTES, offset);
	const buffer = Buffer.alloc(length);
	await handle.read(buffer, 0, length, offset - length);
	return sha1(buffer);
}

/**
 * Read only bytes appended since the last scan. A cursor is trusted only while the file keeps
 * its inode and the bytes just before the cursor are unchanged; otherwise the file was
 * rewritten, its events are dropped and it is read from the start. OMP's in-place title
 * slot at the head of a session file does not disturb either check.
 */
export async function scanJsonlFiles(
	ctx: ScanContext,
	harness: string,
	files: string[],
	parser: JsonlParser,
): Promise<ScanResult> {
	const { db } = ctx;
	const parseCtx: ParseContext = { known: ctx.known, archiveDir: ctx.paths.archiveDir };
	const counter = { added: 0 };
	let scanned = 0;
	for (const file of files) {
		let handle: FileHandle;
		try {
			handle = await open(file, "r");
		} catch {
			continue;
		}
		try {
			const info = await handle.stat();
			const key = `${harness}:${file}`;
			const cursor = db.cursors[key];
			let start = 0;
			if (cursor) {
				const intact = cursor.ino === info.ino && info.size >= cursor.offset && (await readTail(handle, cursor.offset)) === cursor.tail;
				if (intact && info.size === cursor.size) continue;
				if (intact) start = cursor.offset;
				else db.events = db.events.filter(event => event.src !== key);
			}
			scanned++;
			const emit = emitter(ctx, harness, key, counter);
			let pos = start;
			let carry = Buffer.alloc(0);
			while (pos < info.size) {
				const length = Math.min(CHUNK_BYTES, info.size - pos);
				const chunk = Buffer.alloc(length);
				const { bytesRead } = await handle.read(chunk, 0, length, pos);
				if (bytesRead === 0) break;
				pos += bytesRead;
				const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
				const end = data.lastIndexOf(10);
				if (end < 0) {
					carry = data;
					continue;
				}
				parseLines(data.subarray(0, end).toString("utf8"), parser, parseCtx, emit);
				carry = data.subarray(end + 1);
			}
			// A trailing line without newline is still being written; re-read it next time.
			const offset = pos - carry.length;
			db.cursors[key] = { size: offset, mtimeMs: info.mtimeMs, offset, ino: info.ino, tail: await readTail(handle, offset) };
		} finally {
			await handle.close();
		}
	}
	return { added: counter.added, files: scanned };
}

/**
 * Same as {@link scanJsonlFiles} for zstd-compressed JSONL that the writer recompresses
 * whole on every save. A changed file is decompressed and only the decompressed bytes past
 * the cursor are parsed, as long as the bytes before it are unchanged.
 */
export async function scanZstdJsonlFiles(
	ctx: ScanContext,
	harness: string,
	files: string[],
	parser: JsonlParser,
): Promise<ScanResult> {
	const { db } = ctx;
	const parseCtx: ParseContext = { known: ctx.known, archiveDir: ctx.paths.archiveDir };
	const counter = { added: 0 };
	let scanned = 0;
	for (const file of files) {
		const key = `${harness}:${file}`;
		let text: Uint8Array;
		let info: { size: number; mtimeMs: number };
		try {
			const handle = Bun.file(file);
			info = await handle.stat();
			const cursor = db.cursors[key];
			if (cursor && cursor.size === info.size && cursor.mtimeMs === info.mtimeMs) continue;
			text = Bun.zstdDecompressSync(await handle.bytes());
		} catch {
			// unreadable, or caught mid-write
			continue;
		}
		scanned++;
		const cursor = db.cursors[key];
		let start = 0;
		if (cursor) {
			const from = Math.max(0, cursor.offset - TAIL_BYTES);
			const intact = text.length >= cursor.offset && sha1(text.subarray(from, cursor.offset)) === cursor.tail;
			if (intact) start = cursor.offset;
			else db.events = db.events.filter(event => event.src !== key);
		}
		const end = text.lastIndexOf(10) + 1;
		if (end > start) parseLines(Buffer.from(text.subarray(start, end)).toString("utf8"), parser, parseCtx, emitter(ctx, harness, key, counter));
		const offset = Math.max(start, end);
		db.cursors[key] = { size: info.size, mtimeMs: info.mtimeMs, offset, tail: sha1(text.subarray(Math.max(0, offset - TAIL_BYTES), offset)) };
	}
	return { added: counter.added, files: scanned };
}
