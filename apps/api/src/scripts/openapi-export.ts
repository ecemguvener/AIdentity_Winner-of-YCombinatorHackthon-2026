import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { buildOpenApiDocument } from "../openapi.js";

const outputPath = path.resolve(process.cwd(), "../../docs/api/openapi.json");
const document = buildOpenApiDocument(loadConfig());
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${outputPath}`);
