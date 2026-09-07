import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { forkInTmux, ompBootstrapArgs, runForkInTmux } from "../src/index";
import { TmuxClient } from "../src/tmux-client";
import type {
  ExtensionApiLike,
  ExtensionCommandCtx,
  HandlerCtx,
  TmuxLike,
} from "../src/index";

let sessionDir: string;

function fixtureSession(): string {
  const file = join(sessionDir, "current.jsonl");
  writeFileSync(file, '{"type":"session","version":3,"id":"original"}\n');
  return file;
}

async function runTmux(socket: string, argv: readonly string[], path: string): Promise<string> {
  const proc = Bun.spawn(
    [Bun.which("tmux")!, "-S", socket, "-f", "/dev/null", ...argv],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: 3_000,
      env: { PATH: path },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 || proc.signalCode) {
    throw new Error(
      `tmux ${argv[0] ?? ""} failed (exit ${exitCode}): ${stderr.trim()}`,
    );
  }
  return stdout;
}

function fakeTmux(failure?: Error) {
  const calls: {
    targetPane: string;
    cwd: string;
    command: readonly string[];
  }[] = [];
  const tmux: TmuxLike = {
    splitPane: async (opts) => {
      calls.push(opts);
      if (failure) throw failure;
      return "%9";
    },
  };
  return { tmux, calls };
}

function handlerCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  return {
    tmux: fakeTmux().tmux,
    cwd: "/repo",
    sessionFile: fixtureSession(),
    env: { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%4" },
    busy: false,
    notify: () => { },
    ompArgs: [],
    ...overrides,
  };
}

beforeEach(() => {
  sessionDir = `/tmp/fit-handler-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("ompBootstrapArgs", () => {
  it("forwards explicit profile and repeated config overlays", () => {
    expect(
      ompBootstrapArgs(
        [
          "--model",
          "opus",
          "--config",
          "team.yml",
          "--config=local.yml",
          "--profile=work",
        ],
        {},
      ),
    ).toEqual(["--config", "team.yml", "--config=local.yml", "--profile=work"]);
  });

  it("turns an environment-selected profile into an explicit argument", () => {
    expect(ompBootstrapArgs([], { OMP_PROFILE: "work" })).toEqual([
      "--profile",
      "work",
    ]);
    expect(
      ompBootstrapArgs(["--profile", "explicit"], { OMP_PROFILE: "ignored" }),
    ).toEqual(["--profile", "explicit"]);
  });
});

describe("runForkInTmux", () => {
  it.each([
    ["default shell", "", "from-zprofile", "child shell", false],
    ["default shell", "", "from-zprofile", "exec", true],
    ["non-login default-command", "exec /bin/zsh", undefined, "child shell", false],
    ["non-login default-command", "exec /bin/zsh", undefined, "exec", true],
  ] as const)(
    "forks a real pane using tmux's %s",
    async (
      _label: string,
      defaultCommand: string,
      loginValue: string | undefined,
      _mode: string,
      exec: boolean,
    ) => {
      const socket = join(sessionDir, "socket");
      const run = (argv: readonly string[]) => runTmux(socket, argv, `${bin}:/bin`);
      const bin = join(sessionDir, "bin");
      const cwd = join(sessionDir, "working directory");
      const home = join(sessionDir, "home");
      const zdotdir = join(sessionDir, "zsh");
      const reportPath = join(sessionDir, "report.json");
      const tmuxPath = Bun.which("tmux")!;
      const executable = join(bin, "omp");
      const shellPath = `${bin}:/usr/bin:/bin`;
      const profile = "profile 'quoted' \\ $;value";
      const config = "config 'quoted' \\ $;value";
      const sessionFile = join(sessionDir, "session 'quoted' \\ $;value.jsonl");
      mkdirSync(bin);
      mkdirSync(cwd);
      mkdirSync(home);
      mkdirSync(zdotdir);
      writeFileSync(sessionFile, '{"type":"session","version":3,"id":"quoted"}\n');
      writeFileSync(join(zdotdir, ".zprofile"), "export FIT_LOGIN=from-zprofile\n");
      writeFileSync(
        join(zdotdir, ".zshrc"),
        [
          "export FIT_INTERACTIVE=from-zshrc",
          "export EDITOR='shell-editor --interactive'",
          `export PATH='${shellPath}'`,
          "",
        ].join("\n"),
      );
      writeFileSync(executable, `#!${process.execPath}
import { writeFileSync, renameSync } from "node:fs";
const report = ${JSON.stringify(reportPath)};
const tmux = ${JSON.stringify(tmuxPath)};
writeFileSync(report + ".tmp", JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,
}));
renameSync(report + ".tmp", report);
Bun.spawnSync([tmux, "-S", ${JSON.stringify(socket)}, "wait-for", "-S", "report-ready"]);
Bun.spawnSync([tmux, "-S", ${JSON.stringify(socket)}, "wait-for", "probe-exit"]);
process.exit(0);
`);
      chmodSync(executable, 0o755);

      try {
        const originalPane = (await run([
          "new-session", "-d", "-s", "fixture", "-x", "120", "-y", "40",
          "-P", "-F", "#{pane_id}", "/bin/cat",
        ])).trim();
        await run(["set-option", "-w", "-t", "fixture", "remain-on-exit", "on"]);
        await run(["set-option", "-g", "default-shell", "/bin/sh"]);
        await run(["set-option", "-t", "fixture", "default-shell", "/bin/zsh"]);
        await run(["set-option", "-t", "fixture", "default-command", defaultCommand]);
        await run(["set-environment", "-g", "PATH", "/usr/bin:/bin"]);
        await run(["set-environment", "-t", "fixture", "PATH", "/usr/bin:/bin"]);
        await run(["set-environment", "-t", "fixture", "HOME", home]);
        await run(["set-environment", "-t", "fixture", "ZDOTDIR", zdotdir]);
        await run(["set-environment", "-t", "fixture", "EDITOR", "server-editor"]);
        await run(["set-hook", "-t", "fixture", "pane-died", "wait-for -S pane-died"]);
        const globalBefore = await run(["show-environment", "-g"]);
        const sessionBefore = await run(["show-environment", "-t", "fixture"]);
        const hostEnv = {
          TMUX: `${socket},999,0`, TMUX_PANE: originalPane,
          TERM: "invalid-host-terminal", PWD: "/stale-host-directory",
          EDITOR: "host-editor --wait", PATH: "/host-only/path",
          FIT_HOST_ONLY: "host-only",
        };
        await runForkInTmux(
          {
            tmux: new TmuxClient({ run }), cwd, sessionFile, env: hostEnv,
            busy: false, notify: () => { },
            ompArgs: ["--profile", profile, "--config", config],
          },
          { exec },
        );
        await run(["wait-for", "report-ready"]);
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        expect(report.env.FIT_LOGIN).toBe(loginValue);
        expect(report.env.FIT_INTERACTIVE).toBe("from-zshrc");
        expect(report.env.EDITOR).toBe("shell-editor --interactive");
        expect(report.env.FIT_HOST_ONLY).toBeUndefined();
        expect(report.env.PATH).toBe(shellPath);
        expect(report.cwd).toBe(realpathSync(cwd));
        expect(realpathSync(report.env.PWD)).toBe(realpathSync(cwd));
        expect(report.env.TMUX).not.toBe(hostEnv.TMUX);
        expect(report.env.TERM).toBe((await run(["show-options", "-gv", "default-terminal"])).trim());
        expect(report.argv).toEqual([
          "--profile", profile, "--config", config, "--fork", sessionFile,
        ]);
        const panes = (await run([
          "list-panes", "-t", "fixture", "-F", "#{pane_id}:#{pane_active}",
        ])).trim().split("\n");
        expect(panes).toEqual([`${originalPane}:1`, `${report.env.TMUX_PANE}:0`]);
        expect(report.env.TMUX_PANE).not.toBe(originalPane);
        expect(await run(["show-environment", "-g"])).toBe(globalBefore);
        expect(await run(["show-environment", "-t", "fixture"])).toBe(sessionBefore);
        const probePane = report.env.TMUX_PANE as string;
        await run(["wait-for", "-S", "probe-exit"]);
        if (exec) {
          await run(["wait-for", "pane-died"]);
          expect(
            (await run(["display-message", "-p", "-t", probePane, "#{pane_dead}"])).trim(),
          ).toBe("1");
        } else {
          const shellMarker = join(sessionDir, "shell-marker");
          await run([
            "send-keys", "-t", probePane, "-l", "--",
            `printf 'shell-alive' > '${shellMarker}' && ${tmuxPath} -S '${socket}' wait-for -S shell-alive`,
          ]);
          await run(["send-keys", "-t", probePane, "Enter"]);
          await run(["wait-for", "shell-alive"]);
          expect(readFileSync(shellMarker, "utf8")).toBe("shell-alive");
          expect(
            (await run(["display-message", "-p", "-t", probePane, "#{pane_dead}"])).trim(),
          ).toBe("0");
        }
      } catch (error) {
        const output = await run(["capture-pane", "-p", "-S", "-", "-t", "fixture:0.1"]).catch(() => "");
        throw new Error(`Pane probe failed:\n${output}`, { cause: error });
      } finally {
        await run(["kill-server"]).catch(() => { });
      }
    });

  it("refuses outside tmux before touching the session", async () => {
    const { tmux, calls } = fakeTmux();
    const ctx = handlerCtx({ tmux, env: {} });
    const before = readdirSync(sessionDir);
    await expect(runForkInTmux(ctx)).rejects.toThrow(/inside tmux/);
    expect(calls).toEqual([]);
    expect(readdirSync(sessionDir)).toEqual(before);
  });

  it("refuses a stale tmux environment without the current pane id", async () => {
    const { tmux, calls } = fakeTmux();
    const ctx = handlerCtx({
      tmux,
      env: { TMUX: "/tmp/tmux-1000/default,123,0" },
    });
    await expect(runForkInTmux(ctx)).rejects.toThrow(/TMUX_PANE/);
    expect(calls).toEqual([]);
  });

  it("refuses while the agent is busy", async () => {
    const { tmux, calls } = fakeTmux();
    await expect(
      runForkInTmux(handlerCtx({ tmux, busy: true })),
    ).rejects.toThrow(/busy/);
    expect(calls).toEqual([]);
  });

  it("refuses before splitting when omp has not persisted the transcript", async () => {
    const { tmux, calls } = fakeTmux();
    const missing = join(sessionDir, "missing.jsonl");
    await expect(
      runForkInTmux(handlerCtx({ tmux, sessionFile: missing })),
    ).rejects.toThrow(/no transcript/);
    expect(calls).toEqual([]);
  });

  it("surfaces tmux pane creation failures", async () => {
    const { tmux } = fakeTmux(
      new Error("tmux split-window failed (exit 1): no space for new pane"),
    );
    await expect(runForkInTmux(handlerCtx({ tmux }))).rejects.toThrow(
      /no space for new pane/,
    );
  });
});

describe("registration", () => {
  it("registers /fork-in-tmux and parses its optional exec argument", async () => {
    let name = "";
    let handler:
      | ((args: string, ctx: ExtensionCommandCtx) => Promise<void>)
      | undefined;
    const api: ExtensionApiLike = {
      registerCommand: (registeredName, options) => {
        name = registeredName;
        handler = options.handler;
      },
    };
    forkInTmux(api);
    expect(name).toBe("fork-in-tmux");
    expect(handler).toBeDefined();

    const contextError = new Error("context reached");
    let contextTouches = 0;
    const ctx = {
      cwd: "/unused",
      isIdle: () => true,
      ui: { notify: () => { } },
      sessionManager: {
        getSessionFile: () => {
          contextTouches++;
          throw contextError;
        },
      },
    } as ExtensionCommandCtx;

    for (const args of ["", " \t\n", "--exec"]) {
      contextTouches = 0;
      await expect(handler!(args, ctx)).rejects.toBe(contextError);
      expect(contextTouches).toBe(1);
    }

    for (const args of ["unknown", "--exec extra", "--exec --exec"]) {
      contextTouches = 0;
      await expect(handler!(args, ctx)).rejects.toBeInstanceOf(Error);
      expect(contextTouches).toBe(0);
    }
  });
});
