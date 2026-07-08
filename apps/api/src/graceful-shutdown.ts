export interface GracefulShutdownOptions {
  closeHttp: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  drainMs?: number;
  logger?: Pick<Console, "error" | "info">;
  exit?: (code: number) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createGracefulShutdown(options: GracefulShutdownOptions): (signal: NodeJS.Signals) => Promise<void> {
  let shuttingDown = false;
  const drainMs = options.drainMs ?? 10_000;
  const logger = options.logger ?? console;
  const exit = options.exit ?? process.exit;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  return async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}; draining API for up to ${drainMs}ms`);

    const forcedExit = setTimeoutFn(() => {
      logger.error(`graceful shutdown exceeded ${drainMs}ms`);
      exit(1);
    }, drainMs);
    forcedExit.unref?.();

    try {
      await options.closeHttp();
      await options.closeDatabase();
      clearTimeoutFn(forcedExit);
      exit(0);
    } catch (error) {
      clearTimeoutFn(forcedExit);
      logger.error(error instanceof Error ? error.message : String(error));
      exit(1);
    }
  };
}
