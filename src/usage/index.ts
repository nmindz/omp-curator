import { access } from "node:fs/promises";
import { claudeSource } from "./sources/claude.ts";
import { codexSource } from "./sources/codex.ts";
import { dshSource } from "./sources/dsh.ts";
import { ompSource } from "./sources/omp.ts";
import { opencodeSource } from "./sources/opencode.ts";
import type { ScanContext, ScanResult, UsageSource } from "./types.ts";

/** Built-in sources. Add a harness by implementing {@link UsageSource} and listing it here. */
export const USAGE_SOURCES: readonly UsageSource[] = [ompSource, claudeSource, opencodeSource, codexSource, dshSource];

/**
 * Scan every source not disabled in `enabled` (a missing key means enabled).
 *
 * Harnesses come and go: a source whose locations are all gone is reported `missing`, and
 * one that cannot be read reports `error`. Either way the evidence already recorded from
 * it stays, so an uninstalled harness keeps its history. Only a required source (OMP)
 * aborts the scan when it fails.
 */
export async function scanUsage(
	ctx: ScanContext,
	enabled: Record<string, boolean>,
	sources: readonly UsageSource[] = USAGE_SOURCES,
): Promise<Record<string, ScanResult>> {
	const results: Record<string, ScanResult> = {};
	const backfill = !ctx.db.spawnsBackfilled;
	for (const source of sources) {
		if (enabled[source.id] === false) continue;
		const present = await Promise.all(source.locations(ctx.paths).map(path => access(path).then(() => true, () => false)));
		if (!present.some(Boolean)) {
			results[source.id] = { added: 0, files: 0, missing: true };
			continue;
		}
		try {
			// Before the regular scan, which then reads only what is past each cursor.
			if (backfill) await source.backfillSpawns?.(ctx);
			results[source.id] = await scanWithRetry(source, ctx);
		} catch (error) {
			const message = (error as Error).message;
			if (source.required) throw new Error(`usage source "${source.id}" failed: ${message}`);
			results[source.id] = { added: 0, files: 0, error: message };
		}
	}
	ctx.db.spawnsBackfilled = true;
	return results;
}

async function scanWithRetry(source: UsageSource, ctx: ScanContext): Promise<ScanResult> {
	try {
		return await source.scan(ctx);
	} catch {
		// One retry for a file caught mid-write.
		await Bun.sleep(500);
		return source.scan(ctx);
	}
}
