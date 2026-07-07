#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const packageRoot = process.cwd();
const specPath = path.resolve(packageRoot, "../../docs/api/openapi.json");
const outputPath = path.resolve(packageRoot, "src/generated/api.d.ts");
const hashPath = path.resolve(packageRoot, "src/generated/openapi.sha256");

await run("openapi-typescript", [specPath, "-o", outputPath]);
const spec = await fs.readFile(specPath);
await fs.writeFile(hashPath, `${crypto.createHash("sha256").update(spec).digest("hex")}\n`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
