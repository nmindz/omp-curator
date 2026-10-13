import { claudeSource } from "./sources/claude.ts";
import { codexSource } from "./sources/codex.ts";
import { dshSource } from "./sources/dsh.ts";
import { ompSource } from "./sources/omp.ts";
import { opencodeSource } from "./sources/opencode.ts";
import type { ScanContext, ScanResult, UsageSource } from "./types.ts";

/** Built-in sources. Add a harness by implementing {@link UsageSource} and listing it here. */
export const USAGE_SOURCES: readonly UsageSource[] = [ompSource, claudeSource, opencodeSource, codexSource, dshSource];

/** Scan every source not disabled in `enabled` (a missing key means enabled). */
export async function scanUsage(
	ctx: ScanContext,
	enabled: Record<string, boolean>,
	sources: readonly UsageSource[] = USAGE_SOURCES,
): Promise<Record<string, ScanResult>> {
	const results: Record<string, ScanResult> = {};
	for (const source of sources) {
		if (enabled[source.id] === false) continue;
		results[source.id] = await scanWithRetry(source, ctx);
	}
	return results;
}

/**
 * A harness may hold its database mid-checkpoint for a moment ("unable to open database
 * file"), so retry briefly. A source that still fails aborts the scan: a pass with missing
 * evidence could archive skills that were in fact used.
 */
async function scanWithRetry(source: UsageSource, ctx: ScanContext, attempts = 3): Promise<ScanResult> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await source.scan(ctx);
		} catch (error) {
			if (attempt >= attempts) {
				throw new Error(`usage source "${source.id}" failed: ${(error as Error).message} (skip it with \`omp-curator config sources '{"${source.id}":false}'\`)`);
			}
			await Bun.sleep(500 * attempt);
		}
	}
}
