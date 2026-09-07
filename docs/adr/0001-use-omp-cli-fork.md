# Use omp's CLI fork, not plugin-side session copies

`/fork-in-tmux` needs a history-carrying session fork in a new pane while leaving the
original pane untouched. Omp exposes exactly that startup operation as
`omp --fork <session-file>`: `createSessionManager()` resolves the source and delegates
to `SessionManager.forkFrom()`, which creates a fresh session with copied history and
lineage.

The extension therefore owns only pane orchestration. It creates a normal pane with
`tmux split-window`, then uses `tmux send-keys` to run a quoted `omp --fork`
command with the current absolute session path. Omp runs as a child of the shell
by default; `--exec` opts into replacing the shell. Tmux owns shell startup; the
extension does not parse, rewrite, or copy omp session files.

Rejected: invoking interactive `/fork` in the original process. That operation adopts
the fork in the original pane, which violates the pane-fork contract.

Rejected: copying JSONL and artifact directories in the extension. It preserves
artifacts, but duplicates omp's session-format logic and couples the extension to an
internal on-disk schema.

## Consequences

- Omp owns session ids, format migration, lineage, prompt-cache handling, and transcript
  persistence.
- The source session must have been persisted before the pane is created.
- Omp 17.3.5 and newer copy the source artifact directory in the CLI fork path,
  preserving historical `artifact://` references.
