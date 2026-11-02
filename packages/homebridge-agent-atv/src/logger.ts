export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** With `debug` on, debug lines are logged at info level (DESIGN.md §5.1). */
export function withDebug(log: Logger, debug: boolean): Logger {
  if (!debug) return log;
  return {
    debug: (message) => log.info(message),
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
  };
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
