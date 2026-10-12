# omp-curator

Usage-driven skill lifecycle for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP), modelled on the [Hermes Agent curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) and compatible with [vercel-labs/skills](https://github.com/vercel-labs/skills).

- **Measures real usage** from session logs: OMP `skill://` reads, `/skill:` commands and subagent `autoloadSkills`, plus Claude Code and OpenCode history. Shell commands that only touch a skill directory count as *mentions*, never as use.
- **Lifecycle** `active → stale → archived`, with pins, protect globs, and agents' `autoloadSkills` protected automatically. Archiving is a move. Nothing is deleted unless you `purge`.
- **One store.** `~/.omp/agent/skills` holds the only copy of every skill, and `~/.agents/skills` (the `skills` CLI canonical root) is a symlink to it. `skills add -g` installs straight into OMP, and `skills ls -g` lists every OMP skill.
- **OMP extension.** It runs a background pass once per interval, restores an archived skill the moment an agent asks for it, and exposes `/curator`.

## Install

Requires [Bun](https://bun.sh) ≥ 1.3. The [`skills`](https://www.npmjs.com/package/skills) CLI is only needed for `update` and `track`.

```sh
git clone git@github.com:nmindz/omp-curator.git ~/Projects/omp-curator
ln -s ~/Projects/omp-curator/bin/omp-curator ~/.local/bin/omp-curator
omp-curator init --dry-run   # preview the link migration and the first pass
omp-curator init
```

Register the extension (it also ships the `omp-curator` skill) in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/Projects/omp-curator
```

`init` makes `~/.agents/skills` a symlink to the OMP store. Existing entries move into the store. A store entry that was only a link into `~/.agents/skills` is replaced by the real directory, and an independent identical copy is dropped. An entry that differs from a same-named store skill is parked under `~/.omp/agent/curator/conflicts/`. `init` refuses to run when the store and `~/.agents/skills` resolve into each other. It then backfills usage from every session history and records each skill. The first pass labels skills but never archives anything. Automatic passes start one interval later.

## Lifecycle

| State | Meaning |
|---|---|
| `active` | used, or available, within `staleAfterDays` |
| `stale` | idle ≥ `staleAfterDays`; still installed |
| `due` | idle ≥ `archiveAfterDays` and not protected; archived by the next pass when `autoArchive` is on |
| `archived` | moved to `~/.omp/agent/curator/archive/<name>`; invisible to OMP and `skills` |

Idle time runs from the **later** of the last use and the moment the skill became available. That moment is when the store entry itself appeared (for a symlink, the link, not its target), a restore, or a reinstall. A reinstall is any change of the store entry's identity: `skills add`/`update`, `track`, or an installer recreating the directory. A skill you install today is never stale, even if another harness last used it a year ago.

`init` is different: it adopts an existing library. A skill whose recorded usage predates its store entry was migrated, not installed, so its availability is moved back to its first recorded use, and its idle time counts from its last real use. Without this, every skill copied into the store during a migration would look freshly installed.

Usage is attributed by the name OMP registers. When a skill's frontmatter `name` differs from its directory, invocations under either name count, and `skill://<frontmatter-name>` restores the right directory.

Protected skills are never archived automatically:

- skills pinned with `pin`;
- skills matching a `protect` glob;
- skills named in any `~/.omp/agent/agents/*.md` `autoloadSkills`.

Archiving removes the skill's `skills` lock entry and stores it in the archive record, so `skills update` cannot resurrect the skill; `restore` puts the entry back. A skill reinstalled while archived (by `skills add` or another installer) is detected and marked active again.

Archive and restore are crash-safe. The destination and the captured lock entry are saved as a pending intent before anything moves, and the lock changes only after the move. The next pass finishes or rolls back an operation that was interrupted midway. The ledger is best effort and never blocks a state change.

When an agent reads `skill://<name>` for an archived skill, the extension restores it and tells the agent where to read it in the current session. Turn this off with `omp-curator config autoRestoreOnRead false`.

## Commands

```text
status | list [--state S] [--sort K] [--json] | show <skill> | scan | run [--dry-run]
archive <skill...> [--reason TEXT] | restore <skill...> | pin|unpin <skill...>
prune [--days N] [--dry-run] | purge <skill...> | ledger [--limit N]
update [skill...] [--dry-run] | track <skill> <source> | sources <skill>
doctor [--fix] | config [key [value]] | init | link | unlink
```

Inside OMP, run the same commands as `/curator <command>`.

## Working with `skills`

| Goal | Command |
|---|---|
| Install into OMP only | `skills add <source> --skill <name> -g -a pi -y` |
| Update tracked skills | `omp-curator update` |
| Find an upstream for a hand-copied skill | `omp-curator sources <skill>` |
| Put it under version tracking | `omp-curator track <skill> <source>` (backs up the current copy first) |
| List everything | `skills ls -g` |

`-a pi` matters. `pi` is a *universal* `skills` agent, so the install lands only in `~/.agents/skills`, which is the OMP store. Without `-a`, `skills add` and a bare `skills update` symlink the skill into every harness it detects (`~/.claude/skills`, `~/.gemini/skills`, …). `omp-curator update` re-runs installs with `-a pi`, and `omp-curator doctor --fix` removes stray links that point into the store.

`update` and `track` refuse to install while `~/.agents/skills` is not linked to the store, because the install would land outside OMP while the lock reports it as current.

## Configuration

`~/.omp/agent/curator/config.json`. Edit it with `omp-curator config <key> <value>`; values are JSON.

| Key | Default | |
|---|---|---|
| `staleAfterDays` | `30` | idle days before `stale` |
| `archiveAfterDays` | `90` | idle days before `due` |
| `intervalHours` | `168` | minimum time between automatic passes |
| `autoArchive` | `true` | archive `due` skills during passes |
| `autoRestoreOnRead` | `true` | restore an archived skill when an agent reads it |
| `protect` | `[]` | `*` globs never archived automatically |
| `sources` | `{"omp":true,"claude":true,"opencode":true}` | usage sources to scan |
| `skillsCommand` | `"skills"` | `skills` CLI used by `update` and `track` |

`PI_CODING_AGENT_DIR` relocates the OMP agent directory, `OMP_CURATOR_HOME` the curator directory, and `XDG_STATE_HOME` the `skills` lock exactly as the `skills` CLI does.

## Files

```text
~/.omp/agent/curator/
  config.json    policy
  state.json     per-skill state, pins, archive records (with stashed lock entries)
  usage.json     usage events and per-file scan cursors
  ledger.jsonl   every lifecycle change (actor, action, skill, detail)
  archive/       archived skills
  backups/       copies taken before `track` replaces a skill
  conflicts/     entries parked by `init`/`link`
```

## Extending

- **Usage sources** implement `UsageSource` (`src/usage/types.ts`) and are listed in `src/usage/index.ts`. A source scans incrementally: it keeps cursors in `db.cursors` and appends events. JSONL harnesses can reuse `scanJsonlFiles` with a `JsonlParser`.
- **Integrations** implement `Integration` (`src/integrations/types.ts`). `beforeArchive` captures data without side effects; the capture is persisted with the archive intent. `afterArchive` applies the change once the skill has moved, and `afterRestore` undoes it with the same capture. Both must be idempotent, because `sync()` replays them for interrupted operations. `origins` labels listings, and `doctor` / `fix` report and repair. The `skills` lock handling in `src/integrations/vercel/` is the reference implementation.

## Development

```sh
bun test
```

Each fix of a reproduced defect has a regression test in `test/hardening.test.ts`.
The tests run against throwaway home directories with an injected clock. The `skills` CLI and GitHub are stubbed through `RemoteDeps`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
