import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { createNotificationClient } from "./notifications.js";
import { createControlServer } from "./server.js";
import { loadState, createStateWriter } from "./storage.js";
import { SyncthingMonitor } from "./syncthing.js";

const logger = createLogger(config.logLevel);
const shutdownController = new AbortController();
let stopping = false;
let monitor;
let controlServer;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;

  logger.info("shutdown_started", { signal });
  shutdownController.abort();

  await Promise.allSettled([
    controlServer?.stop(),
    monitor?.stop()
  ]);

  logger.info("shutdown_completed");
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (error) => {
  logger.error("unhandled_rejection", {
    error: error instanceof Error ? error.message : String(error)
  });
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { error: error.message });
  void shutdown("uncaughtException").finally(() => {
    process.exitCode = 1;
  });
});

try {
  const state = await loadState(config.stateFile, logger);
  const saveState = createStateWriter(config.stateFile, logger);
  const notifications = createNotificationClient(
    config,
    logger,
    shutdownController.signal
  );

  monitor = new SyncthingMonitor({
    config,
    logger,
    state,
    saveState,
    notifications,
    shutdownSignal: shutdownController.signal
  });

  controlServer = createControlServer({
    config,
    logger,
    notifications,
    getStatus: () => monitor.getStatus()
  });

  await controlServer.start();

  logger.info("application_started", {
    stateFile: config.stateFile,
    quietPeriodMs: config.quietPeriodMs,
    httpPort: config.httpPort
  });

  await monitor.run();
} catch (error) {
  if (!stopping) {
    logger.error("application_failed", { error: error.message });
    process.exitCode = 1;
    await shutdown("application_failed");
  }
}
