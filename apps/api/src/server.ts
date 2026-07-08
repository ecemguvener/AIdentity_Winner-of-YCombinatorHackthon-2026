import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { buildApp } from "./app.js";
import { createGracefulShutdown } from "./graceful-shutdown.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.info(`capabilities: email=${config.PROVIDER_MODE_EMAIL} phone=${config.PROVIDER_MODE_PHONE}`);

const database = await connectDatabase(config);
const app = await buildApp(config, database.collections);

const shutdown = createGracefulShutdown({
  closeHttp: () => app.close(),
  closeDatabase: () => database.client.close()
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
process.send?.("ready");
