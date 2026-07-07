#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const skillRoot = path.join(repoRoot, "openclaw-skills");
const bannedPatterns = [
  /IDENTITY_LAYER_/,
  /identity_live_/,
  /calendar_book/,
  /\/api\/tools\/phone\/call/,
  /\/api\/tools\/email\/send/,
  /\/api\/tools\/calendar\/book/,
  /\bsimulated\b/i
];

async function main() {
  runSelfTest();
  const skillFiles = await findSkillFiles(skillRoot);
  if (skillFiles.length === 0) {
    throw new Error("no OpenClaw skills found");
  }
  for (const file of skillFiles) {
    await validateSkillFile(file);
  }
  console.log(`Validated ${skillFiles.length} OpenClaw skill(s).`);
}

async function findSkillFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, "SKILL.md");
    try {
      await fs.access(candidate);
      files.push(candidate);
    } catch {
      // Ignore non-skill folders.
    }
  }
  return files;
}

async function validateSkillFile(file) {
  const source = await fs.readFile(file, "utf8");
  const parsed = parseFrontmatter(source);
  const relative = path.relative(repoRoot, file);
  requireField(parsed.frontmatter, "name", relative);
  requireField(parsed.frontmatter, "description", relative);
  if (!parsed.frontmatter.homepage) {
    throw new Error(`${relative}: missing homepage`);
  }
  if (!/metadata\s*:\s*\{[^}]*openclaw/s.test(parsed.rawFrontmatter)) {
    throw new Error(`${relative}: metadata.openclaw missing`);
  }
  for (const pattern of bannedPatterns) {
    if (pattern.test(source)) {
      throw new Error(`${relative}: banned legacy string matched ${pattern}`);
    }
  }
}

function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) {
    throw new Error("missing YAML frontmatter");
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("unterminated YAML frontmatter");
  }
  const rawFrontmatter = source.slice(4, end).trim();
  const frontmatter = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, rawFrontmatter };
}

function requireField(frontmatter, field, file) {
  if (!frontmatter[field]) {
    throw new Error(`${file}: missing ${field}`);
  }
}

function runSelfTest() {
  let failed = false;
  try {
    parseFrontmatter("# no frontmatter");
  } catch {
    failed = true;
  }
  if (!failed) {
    throw new Error("frontmatter self-test failed");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
