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
		results[source.id] = await source.scan(ctx);
	}
	return results;
}
