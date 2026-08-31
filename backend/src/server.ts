import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./config/logger.js";
import { Container } from "./services/container.js";
import { registerExamples } from "./services/examples.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "bugbaar-engine" });
  const container = new Container(config, logger);

  await container.ready();
  await registerExamples(container);

  const app = createApp(container, config, logger);
  const server = app.listen(config.port, () => {
    logger.info("BugBaar Engine listening", {
      port: config.port,
      env: config.env,
      llmProvider: container.provider.name,
      authRequired: config.apiKeys.length > 0,
      persistent: container.persistent,
    });
  });

  // Drain in-flight requests before exiting so deploys don't drop connections.
  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });

    // End open streams before server.close() starts waiting on connections.
    // An SSE stream never ends by itself, so this is the difference between a
    // clean exit and the watchdog forcing exit(1).
    const closed = container.streams.closeAll();
    if (closed > 0) logger.info("closed open streams", { count: closed });
    const timer = setTimeout(() => {
      logger.error("forced exit after shutdown timeout");
      process.exit(1);
    }, 10_000);
    timer.unref();

    server.close(() => {
      void container.shutdown().then(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { reason: String(reason) }));
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start BugBaar Engine: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
