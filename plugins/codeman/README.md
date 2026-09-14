# codeman (Claude Code plugin)

The agent skill for [Codeman](https://getcodeman.com), the self-hosted mission control for AI coding agents. With it, a Claude Code session running inside Codeman can start other sessions, prompt them, block until they finish, read their answers and clean up, in plain English instead of API calls.

```
/plugin marketplace add Ark0N/Codeman
/plugin install codeman@codeman
```

The skill acts only inside a Codeman-managed session (`CODEMAN_MUX=1`) and refuses everywhere else, so installing it globally costs nothing for unrelated sessions.

This directory is a mirror of [`skills/codeman`](../../skills/codeman) in the main repository, kept byte-identical by `scripts/sync-plugin.mjs` and pinned by a test. Edit the source there, never here. Source, issues and the rest of Codeman: https://github.com/Ark0N/Codeman
