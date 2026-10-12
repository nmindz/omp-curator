import type { Paths } from "../paths.ts";
import type { CuratorConfig } from "../store.ts";

export interface IntegrationContext {
	paths: Paths;
	config: CuratorConfig;
}

export interface Finding {
	level: "ok" | "warn" | "error";
	message: string;
	/** Command or action that resolves the finding. */
	fix?: string;
}

/**
 * Something outside the OMP store that must stay consistent with a skill's lifecycle,
 * such as a package manager's lock file.
 *
 * Archive is crash-safe in phases: `beforeArchive` only captures data (no side effects); the
 * capture is persisted with the archive intent; the skill moves; then `afterArchive` applies
 * the integration's change. `afterRestore` receives the same capture. `afterArchive` and
 * `afterRestore` must be idempotent: an interrupted archive or restore is replayed by `sync()`.
 */
export interface Integration {
	id: string;
	beforeArchive?(ctx: IntegrationContext, name: string): Promise<unknown>;
	afterArchive?(ctx: IntegrationContext, name: string, stashed: unknown): Promise<void>;
	afterRestore?(ctx: IntegrationContext, name: string, stashed: unknown): Promise<void>;
	/** Short provenance labels by skill name, shown in listings. */
	origins?(ctx: IntegrationContext): Promise<Record<string, string>>;
	doctor?(ctx: IntegrationContext): Promise<Finding[]>;
	/** Repair what `doctor` reports; returns a line per change made. */
	fix?(ctx: IntegrationContext): Promise<string[]>;
}
