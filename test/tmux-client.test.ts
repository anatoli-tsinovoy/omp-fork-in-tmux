import { describe, expect, it } from "bun:test";
import { processRunner, TmuxClient, type Runner } from "../src/tmux-client";

function clientWith(splitOutput = "") {
  const runner: Runner = {
    run: async () => splitOutput,
  };
  return { client: new TmuxClient(runner) };
}

describe("tmux client", () => {
  it("fails loudly when tmux returns no pane id", async () => {
    const { client } = clientWith("");
    await expect(
      client.splitPane({
        targetPane: "%4",
        cwd: "/repo",
        command: ["omp"],
      }),
    ).rejects.toThrow(/no pane id/);
  });

  it("propagates runner failures", async () => {
    const runner: Runner = {
      run: async () => {
        throw new Error(
          "tmux split-window failed (exit 1): no space for new pane",
        );
      },
    };
    await expect(
      new TmuxClient(runner).splitPane({
        targetPane: "%4",
        cwd: "/repo",
        command: ["omp"],
      }),
    ).rejects.toThrow(/no space for new pane/);
  });

  it("processRunner surfaces exit code and stderr", async () => {
    await expect(
      processRunner.run(["definitely-not-a-tmux-command"]),
    ).rejects.toThrow(/exit \d+/);
  });
});
