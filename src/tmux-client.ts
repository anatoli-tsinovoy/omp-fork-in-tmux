/**
 * Executes a tmux CLI invocation: argv without the leading "tmux",
 * returning stdout. Implementations reject when tmux exits non-zero.
 */
export interface Runner {
 run(argv: readonly string[]): Promise<string>;
}

/** Runs `tmux <argv...>` and captures stdout; rejects on non-zero exit. */
export const processRunner: Runner = {
 run: async (argv) => {
  const proc = Bun.spawn(["tmux", ...argv], {
   stdout: "pipe",
   stderr: "pipe",
   stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
   new Response(proc.stdout).text(),
   new Response(proc.stderr).text(),
   proc.exited,
  ]);
  if (exitCode !== 0) {
   throw new Error(
    `tmux ${argv[0]?.toString() ?? ""} failed (exit ${exitCode}): ${stderr.trim()}`,
   );
  }
  return stdout;
 },
};

export interface SplitPaneOptions {
 targetPane: string;
 cwd: string;
 command: readonly string[];
}

/** The single choke point for creating the pane that runs omp's fork. */
export class TmuxClient {
 #runner: Runner;

 constructor(runner: Runner = processRunner) {
  this.#runner = runner;
 }

 async splitPane(opts: SplitPaneOptions): Promise<string> {
  const out = await this.#runner.run([
   "split-window",
   "-d",
   "-c",
   opts.cwd,
   "-t",
   opts.targetPane,
   "-P",
   "-F",
   "#{pane_id}",
  ]);
  const paneId = out.trim();
  if (paneId === "") {
   throw new Error("tmux split-window returned no pane id");
  }
  // Type into the shell tmux started, rather than choosing its startup mode.
  const command = opts.command
   .map((arg) => `'${arg.replace(/['\\]/g, (char) => `'\\${char}'`)}'`)
   .join(" ");
  await this.#runner.run(["send-keys", "-t", paneId, "-l", "--", command]);
  await this.#runner.run(["send-keys", "-t", paneId, "Enter"]);
  return paneId;
 }
}
