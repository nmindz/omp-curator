import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
	home: string;
	/** OMP agent directory (`~/.omp/agent`, or `PI_CODING_AGENT_DIR`). */
	agentDir: string;
	/** OMP native user skills root; the single real store for every skill. */
	skillsDir: string;
	/** OMP user agent definitions, scanned for `autoloadSkills` references. */
	agentDefsDir: string;
	sessionsDir: string;
	curatorDir: string;
	archiveDir: string;
	backupDir: string;
	conflictsDir: string;
	configPath: string;
	statePath: string;
	usagePath: string;
	ledgerPath: string;
	/** Vercel `skills` canonical global root (`~/.agents/skills`). */
	agentsSkillsDir: string;
	/** Vercel `skills` global lock file. */
	lockPath: string;
	claudeProjectsDir: string;
	opencodeDb: string;
	/** Codex rollouts: `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`. */
	codexSessionsDirs: string[];
	/** DeepSeek Harness sessions (`$DSH_HOME/sessions`). */
	dshSessionsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
	const home = env.HOME || homedir();
	const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".omp", "agent");
	const curatorDir = env.OMP_CURATOR_HOME || join(agentDir, "curator");
	const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
	const codexHome = env.CODEX_HOME || join(home, ".codex");
	return {
		home,
		agentDir,
		skillsDir: join(agentDir, "skills"),
		agentDefsDir: join(agentDir, "agents"),
		sessionsDir: join(agentDir, "sessions"),
		curatorDir,
		archiveDir: join(curatorDir, "archive"),
		backupDir: join(curatorDir, "backups"),
		conflictsDir: join(curatorDir, "conflicts"),
		configPath: join(curatorDir, "config.json"),
		statePath: join(curatorDir, "state.json"),
		usagePath: join(curatorDir, "usage.json"),
		ledgerPath: join(curatorDir, "ledger.jsonl"),
		agentsSkillsDir: join(home, ".agents", "skills"),
		// Mirrors getSkillLockPath() in vercel-labs/skills.
		lockPath: env.XDG_STATE_HOME
			? join(env.XDG_STATE_HOME, "skills", ".skill-lock.json")
			: join(home, ".agents", ".skill-lock.json"),
		claudeProjectsDir: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
		opencodeDb: join(dataHome, "opencode", "opencode.db"),
		codexSessionsDirs: [join(codexHome, "sessions"), join(codexHome, "archived_sessions")],
		dshSessionsDir: join(env.DSH_HOME || join(home, ".dsh"), "sessions"),
	};
}
