import { TmuxClient } from "./tmux-client";

/**
 * The omp-fork-in-tmux extension factory surface needs. omp's real
 * ExtensionAPI is broader; this structural type avoids importing omp internals.
 */
export interface ExtensionApiLike {
 registerCommand(
  name: string,
  options: {
   description?: string;
   handler: (args: string, ctx: ExtensionCommandCtx) => Promise<void>;
  },
 ): void;
}

/** The subset of omp's ExtensionCommandContext used by /fork-in-tmux. */
export interface ExtensionCommandCtx {
 cwd: string;
 isIdle(): boolean;
 ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
 sessionManager: { getSessionFile(): string | undefined };
}

/** Injected handler dependencies keep tmux process creation testable. */
export interface HandlerCtx {
 tmux: TmuxLike;
 cwd: string;
 sessionFile: string;
 env: Record<string, string | undefined>;
 busy: boolean;
 notify: (message: string) => void;
 /** Bootstrap args of the running omp process (for example, ["--profile", "work"]). */
 ompArgs: readonly string[];
}

export interface TmuxLike {
 splitPane: TmuxClient["splitPane"];
}

export function ompBootstrapArgs(
 argv: readonly string[] = process.argv.slice(2),
 env: Record<string, string | undefined> = process.env,
): string[] {
 const forwarded: string[] = [];
 let hasProfileFlag = false;

 for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  const namedValue = arg === "--profile" || arg === "--config";
  const inlineValue =
   arg.startsWith("--profile=") || arg.startsWith("--config=");
  if (!namedValue && !inlineValue) continue;

  if (arg === "--profile" || arg.startsWith("--profile=")) {
   hasProfileFlag = true;
  }
  forwarded.push(arg);
  if (namedValue && argv[i + 1] !== undefined) {
   forwarded.push(argv[++i]!);
  }
 }

 const envProfile = env.OMP_PROFILE ?? env.PI_PROFILE;
 if (!hasProfileFlag && envProfile) {
  forwarded.unshift("--profile", envProfile);
 }
 return forwarded;
}

function handlerCtx(ctx: ExtensionCommandCtx): HandlerCtx {
 const sessionFile = ctx.sessionManager.getSessionFile();
 if (!sessionFile)
  throw new Error("fork-in-tmux: current session has no session file");
 return {
  tmux: new TmuxClient(),
  cwd: ctx.cwd,
  sessionFile,
  env: process.env,
  busy: !ctx.isIdle(),
  notify: (message) => ctx.ui.notify(message, "info"),
  ompArgs: ompBootstrapArgs(),
 };
}

export async function runForkInTmux(
 ctx: HandlerCtx,
 options?: { exec?: boolean },
): Promise<void> {
 const { TMUX, TMUX_PANE } = ctx.env;
 if (!TMUX || !TMUX_PANE) {
  throw new Error(
   "fork-in-tmux: omp is not running inside tmux (TMUX/TMUX_PANE unset)",
  );
 }
 if (ctx.busy) {
  throw new Error(
   "fork-in-tmux: agent is busy — wait for the current turn to finish",
  );
 }
 if (!(await Bun.file(ctx.sessionFile).exists())) {
  throw new Error(
   "fork-in-tmux: session has no transcript yet — send a message before forking",
  );
 }

 try {
  const command = ["omp", ...ctx.ompArgs, "--fork", ctx.sessionFile];
  if (options?.exec) command.unshift("exec");
  const paneId = await ctx.tmux.splitPane({
   targetPane: TMUX_PANE,
   cwd: ctx.cwd,
   command,
  });
  ctx.notify(`fork-in-tmux: forked into ${paneId}`);
 } catch (err) {
  throw new Error(
   `fork-in-tmux: could not create tmux pane: ${err instanceof Error ? err.message : String(err)}`,
  );
 }
}

export function forkInTmux(pi: ExtensionApiLike): void {
 pi.registerCommand("fork-in-tmux", {
  description: "Pane-fork this conversation; --exec replaces the new pane's shell",
  handler: async (args, ctx) => {
   const arg = args.trim();
   if (arg !== "" && arg !== "--exec") {
    throw new Error("Usage: /fork-in-tmux [--exec]");
   }
   await runForkInTmux(handlerCtx(ctx), { exec: arg === "--exec" });
  },
 });
}

export default forkInTmux;
