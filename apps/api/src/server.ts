import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { buildApp } from "./app.js";

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

const close = async () => {
  await app.close();
  await database.client.close();
};

process.on("SIGINT", () => void close().then(() => process.exit(0)));
process.on("SIGTERM", () => void close().then(() => process.exit(0)));

await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
