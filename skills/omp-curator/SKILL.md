---
name: omp-curator
description: "Use for questions about which skills are actually used, unused, stale or archived; to archive, restore, pin or prune skills; and to install, update or track skills with vercel-labs/skills (`skills add`) in OMP."
---

# omp-curator

`omp-curator` measures real skill usage from session logs and manages each skill's lifecycle: **active → stale → archived**. The OMP store `~/.omp/agent/skills` is the only real copy of every skill; `~/.agents/skills` (the vercel-labs/skills canonical root) is a symlink to it.

Run the CLI with `bash`. Inside an interactive OMP session the user can also type `/curator <command>`.

## Answering usage questions

Report numbers from the tool, never from memory or file timestamps.

| Question | Command |
|---|---|
| Overview, counts, next automatic pass | `omp-curator status` |
| Most used | `omp-curator list --sort uses` |
| Unused / idle | `omp-curator list --sort idle` or `--state stale` |
| Due for archiving | `omp-curator list --state due` |
| Archived | `omp-curator list --state archived` |
| Evidence for one skill | `omp-curator show <skill>` |
| Machine-readable | add `--json` to `list` |

Usage counts only structured invocations: OMP `skill://` reads, SKILL.md reads, `/skill:` commands, subagent `autoloadSkills`, Claude Code `Skill` tool calls and OpenCode `skill` tool calls. Shell commands that merely touch a skill directory are tallied as *mentions* and never count as use. `idle` is measured from the later of the last use and the time the skill became available, so a newly installed skill is never instantly stale.

Run `omp-curator scan` first when the user asks about very recent activity.

## Lifecycle changes

- Archive: `omp-curator archive <skill...> --reason "<why>"`. The directory moves to `~/.omp/agent/curator/archive/`; its vercel-labs/skills lock entry is stashed so `skills update` cannot resurrect it.
- Restore: `omp-curator restore <skill...>`. Restored skills are listed again in new OMP sessions; read `~/.omp/agent/skills/<skill>/SKILL.md` directly in the current one.
- Pin (never auto-archive): `omp-curator pin <skill...>`; undo with `unpin`.
- Bulk: `omp-curator prune --days N --dry-run`, then without `--dry-run` once the user agrees.
- Policy: `omp-curator config staleAfterDays 45`, `config archiveAfterDays 120`, `config autoArchive false`.
- `purge` deletes archived copies permanently. Only run it when the user explicitly asks.

Show `--dry-run` output and get the user's agreement before bulk archiving or pruning.

If `skill://<name>` fails because the skill was archived, the extension restores it automatically and tells you where to read it.

## Installing and updating skills (vercel-labs/skills)

- Install into OMP only: `skills add <source> --skill <name> -g -a pi -y`. `pi` is a universal agent, so files land only in the OMP store. Omitting `-a` symlinks the skill into every detected harness (`~/.claude/skills`, …).
- Update: prefer `omp-curator update [skill...]` (checks GitHub tree hashes, reinstalls with `-a pi`). A bare `skills update` re-adds symlinks for every detected harness; clean them with `omp-curator doctor --fix`.
- Track a skill that was copied in by hand: `omp-curator sources <skill>` lists published sources on skills.sh; `omp-curator track <skill> <source>` reinstalls it from that source after backing up the current copy.
- `skills ls -g` lists every OMP skill because `~/.agents/skills` points at the store.

## Health

`omp-curator doctor` reports the link state, stray `skills` symlinks in other harness directories, lock entries without a skill, and SKILL.md files OMP cannot load (missing description). `--fix` removes stray links.
