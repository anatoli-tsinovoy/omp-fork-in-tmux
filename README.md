# omp-fork-in-tmux

An omp extension that adds `/fork-in-tmux`: fork the current conversation into a new tmux pane while the original pane keeps running and retains focus.

**Why:** omp's interactive `/fork` continues the current pane on the fork. This extension starts omp's built-in CLI fork in a sibling pane instead.

## Install

Requires omp 17.3.5 or newer and tmux 3.2 or newer.

```sh
omp plugin install https://github.com/anatoli-tsinovoy/omp-fork-in-tmux
```

Omp links the plugin from git into `~/.omp/plugins`; `/fork-in-tmux` is then available in every session. Use `--scope project` to install only in the current project. Update later with `omp plugin upgrade`.

## Use

Run omp inside tmux, then type `/fork-in-tmux`. The command:

1. Refuses when `TMUX` or `TMUX_PANE` is unset, while the agent is mid-turn, or before omp has persisted the first transcript entry.
2. Runs a normal tmux `split-window`, preserving the working directory and focus. Tmux handles startup using its existing `default-command` and `default-shell` configuration.
3. Uses tmux `send-keys` to enter the quoted `omp [--profile …] [--config …] --fork <current-session-file>` command in the new pane. Explicit profile and config overlays are forwarded; ordinary global, profile, and project config is rediscovered by omp from the same profile and working directory.

The original pane and session are never modified. Omp owns the forked transcript, lineage, prompt-cache state, and artifact copy.

By default, exiting omp returns to the shell in the new pane. Use `/fork-in-tmux --exec` to replace that shell with omp instead; there is then no shell to return to, and tmux's normal pane-exit behavior applies (including `remain-on-exit`).

Shell startup and environment behave as they do for a normal tmux split. The extension neither chooses login/non-login mode nor copies the running omp process's environment. Settings such as `EDITOR` and `PATH` come from the shell that tmux starts. Exports made only in the original pane after startup are not copied. Other panes and tmux's stored environment are unchanged.

### Troubleshooting

- **"omp is not running inside tmux"** — start tmux, run omp in a pane, and invoke the command again.
- **"session has no transcript yet"** — omp writes the session file only after the first turn. Send a message first, then pane-fork.
- **Historical `artifact://` references do not resolve in the new pane** — upgrade to omp 17.3.5 or newer.

## Develop

```sh
bun install
bun run typecheck
bun test
```

`omp plugin install /path/to/this/repo` links the local checkout for development. Tests cover argument handling and command guards, and use an isolated tmux server to verify native startup, shell survival versus `--exec`, quoted command arguments, working directory, and focus without touching your tmux sessions. Domain vocabulary lives in `CONTEXT.md`, and the fork-mechanism decision lives in `docs/adr/0001-use-omp-cli-fork.md`.
