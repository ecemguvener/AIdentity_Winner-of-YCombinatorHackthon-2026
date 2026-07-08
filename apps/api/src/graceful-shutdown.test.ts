import { describe, expect, it } from "vitest";
import { createGracefulShutdown } from "./graceful-shutdown.js";

describe("createGracefulShutdown", () => {
  it("closes HTTP before Mongo and exits cleanly", async () => {
    const calls: string[] = [];
    let exitCode: number | null = null;
    const shutdown = createGracefulShutdown({
      closeHttp: async () => void calls.push("http"),
      closeDatabase: async () => void calls.push("mongo"),
      exit: (code) => void (exitCode = code),
      logger: silentLogger()
    });

    await shutdown("SIGTERM");

    expect(calls).toEqual(["http", "mongo"]);
    expect(exitCode).toBe(0);
  });

  it("does not run the close sequence twice", async () => {
    let closeCount = 0;
    const shutdown = createGracefulShutdown({
      closeHttp: async () => void (closeCount += 1),
      closeDatabase: async () => undefined,
      exit: () => undefined,
      logger: silentLogger()
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(closeCount).toBe(1);
  });

  it("exits non-zero when closing fails", async () => {
    let exitCode: number | null = null;
    const shutdown = createGracefulShutdown({
      closeHttp: async () => {
        throw new Error("close failed");
      },
      closeDatabase: async () => undefined,
      exit: (code) => void (exitCode = code),
      logger: silentLogger()
    });

    await shutdown("SIGTERM");

    expect(exitCode).toBe(1);
  });
});

function silentLogger() {
  return {
    error: () => undefined,
    info: () => undefined
  };
}
