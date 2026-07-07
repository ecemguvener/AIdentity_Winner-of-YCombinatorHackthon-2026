import { loadConfig } from "./config.js";

try {
  loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
