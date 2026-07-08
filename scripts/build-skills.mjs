#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const sourceDir = path.join(repoRoot, "skills", "barkan-identity");
const sourceSkill = path.join(sourceDir, "SKILL.md");

const variants = [
  {
    outputDir: path.join(repoRoot, "openclaw-skills", "barkan-identity"),
    frontmatter: `---
name: barkan-identity
description: Give this agent a real-world identity (email address, phone number) via Barkan. Use for sending/receiving email, making phone calls, and SMS (including fetching 2FA codes).
homepage: https://aidentity.space
metadata: { openclaw: { requiredEnv: ["BARKAN_API_URL", "BARKAN_IDENTITY_TOKEN"], emoji: "🪪" } }
---`
  },
  {
    outputDir: path.join(repoRoot, "hermes-skills", "barkan-identity"),
    frontmatter: `---
name: barkan-identity
description: Give this Hermes agent a real-world identity (email address, phone number) via Barkan. Use for sending/receiving email, making phone calls, and SMS (including fetching 2FA codes).
homepage: https://aidentity.space
metadata: { hermes: { requiredEnv: ["BARKAN_API_URL", "BARKAN_IDENTITY_TOKEN"], tags: ["identity", "mcp", "email", "phone", "sms"] } }
---`
  }
];

async function main() {
  const source = await fs.readFile(sourceSkill, "utf8");
  const body = stripFrontmatter(source);
  for (const variant of variants) {
    await fs.rm(variant.outputDir, { recursive: true, force: true });
    await fs.mkdir(variant.outputDir, { recursive: true });
    await fs.writeFile(path.join(variant.outputDir, "SKILL.md"), `${variant.frontmatter}\n\n${body.trim()}\n`);
    await copyIfExists(path.join(sourceDir, "references"), path.join(variant.outputDir, "references"));
    await copyIfExists(path.join(sourceDir, "skill.json"), path.join(variant.outputDir, "skill.json"));
  }
  console.log(`Built ${variants.length} skill variant(s).`);
}

function stripFrontmatter(source) {
  if (!source.startsWith("---\n")) {
    return source;
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("canonical skill frontmatter is unterminated");
  }
  return source.slice(end + 4).trim();
}

async function copyIfExists(from, to) {
  try {
    await fs.cp(from, to, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
