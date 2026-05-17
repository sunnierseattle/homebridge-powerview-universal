import type { Logging } from 'homebridge';

/**
 * Formats an unknown thrown value for log output (message and stack when available).
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/**
 * Logs an error with a message prefix using Homebridge's logging API.
 */
export function logError(log: Logging, message: string, error: unknown): void {
  log.error(message, formatError(error));
}

/**
 * Registers process-level handlers so async/sync failures are logged instead of
 * crashing the child bridge with no context.
 */
export function registerProcessErrorHandlers(log: Logging, pluginName: string): void {
  const label = pluginName;

  process.on('unhandledRejection', (reason) => {
    log.error(`[${label}] Unhandled promise rejection:`, formatError(reason));
  });

  process.on('uncaughtException', (error) => {
    log.error(`[${label}] Uncaught exception:`, formatError(error));
  });
}
