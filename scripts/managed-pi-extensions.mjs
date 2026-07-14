#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadManagedToolsConfig } from "./managed-tools-config.mjs";
import { actionForState, diagnosticForState, printCompareRow, printStatusRow } from "./managed-tools-output.mjs";

const execFileAsync = promisify(execFile);
const command = process.argv[2] ?? "status";
const repoRoot = path.resolve(import.meta.dirname, "..");

const { manifest, policy } = await loadManagedToolsConfig(repoRoot);
const comparePolicy = policy.policy?.compare ?? {};
const family = manifest.families?.pi_extensions;
if (!family) throw new Error("managed-tools manifest missing pi_extensions family");

const tools = family.tools ?? [];
if (tools.length === 0) throw new Error("pi_extensions family has no tools");

// ── Paths ─────────────────────────────────────────────────────────────────
const home = os.homedir();
const piAgentDir = path.join(home, ".pi", "agent");
const piNpmDir = path.join(piAgentDir, "npm");
const piSettingsPath = path.join(piAgentDir, "settings.json");
const statePath = path.join(home, ...family.statePath.replace(/^~\//, "").split("/"));
const stateFilePath = path.join(statePath, "installed-versions.json");

// ── Versioning ────────────────────────────────────────────────────────────
function stripPrefix(v) { return String(v).replace(/^v/, ""); }

function compareVersions(left, right) {
  const leftParts = stripPrefix(left).split(".").map(Number);
  const rightParts = stripPrefix(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const l = leftParts[i] ?? 0;
    const r = rightParts[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

function compareState(installed, expected) {
  if (!installed) return "missing";
  if (!/^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(installed)) return "unparseable";
  const cmp = compareVersions(installed, expected);
  if (cmp === 0) return "equal";
  if (cmp < 0) return "lower";
  return "higher";
}

// ── Status helpers ────────────────────────────────────────────────────────
async function readPackageVersion(pkg) {
  const pkgJsonPath = path.join(piNpmDir, "node_modules", pkg, "package.json");
  try {
    const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    return pkgJson.version ?? null;
  } catch {
    return null;
  }
}

async function readSettingsPackages() {
  try {
    const settings = JSON.parse(await readFile(piSettingsPath, "utf8"));
    return Array.isArray(settings.packages) ? settings.packages : [];
  } catch {
    return [];
  }
}


// ── Install helpers ───────────────────────────────────────────────────────
// Replicates what `pi install npm:<pkg>` does internally:
//   1. npm install <pkg>@<version> into ~/.pi/agent/npm/
//   2. Add "npm:<pkg>" to ~/.pi/agent/settings.json packages array
// We don't shell out to `pi install` because the pi binary may not be on
// PATH yet during managed-tools:init (it's installed as a managed npm tool
// in the same init pass).
async function runPiInstall(tool) {
  console.log(`[install] npm install ${tool.pkg}@${tool.version} into ${piNpmDir}...`);

  // Step 1: npm install into the pi agent npm directory
  await mkdir(piNpmDir, { recursive: true });
  await execFileAsync("npm", [
    "install", "--prefix", piNpmDir, "--ignore-scripts",
    `${tool.pkg}@${tool.version}`,
  ], {
    cwd: home,
    env: { ...process.env, HOME: home },
    maxBuffer: 10 * 1024 * 1024,
  });

  // Step 2: Register in ~/.pi/agent/settings.json
  const packageEntry = `npm:${tool.name}`;
  let settings = {};
  try {
    settings = JSON.parse(await readFile(piSettingsPath, "utf8"));
  } catch {
    // settings.json doesn't exist yet
  }
  if (!Array.isArray(settings.packages)) {
    settings.packages = [];
  }
  if (!settings.packages.includes(packageEntry)) {
    settings.packages.push(packageEntry);
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(piSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    console.log(`[install] registered ${packageEntry} in pi settings.json`);
  }
}

async function readInstalledVersions() {
  const versions = {};
  for (const tool of tools) {
    versions[tool.name] = await readPackageVersion(tool.pkg);
  }
  return versions;
}

async function writeStateFile(versions) {
  await mkdir(statePath, { recursive: true });
  await writeFile(stateFilePath, JSON.stringify(versions, null, 2) + "\n", "utf8");
}

// ── Row helpers ───────────────────────────────────────────────────────────
function rowForTool(tool, installed) {
  const desired = tool.version;
  const state = compareState(installed, desired);
  return {
    family: "pi_extensions",
    tool: tool.name,
    desired,
    actual: installed,
    path: path.join(piNpmDir, "node_modules", tool.pkg),
    state,
    action: actionForState(comparePolicy, state),
    diagnostic: diagnosticForState(state, "pi-extension"),
    source: "managed-tools-config",
  };
}

// ── Commands ──────────────────────────────────────────────────────────────
async function runInstall() {
  await mkdir(piAgentDir, { recursive: true });
  let installedAny = false;

  for (const tool of tools) {
    const installed = await readPackageVersion(tool.pkg);
    const state = compareState(installed, tool.version);
    if (state === "higher") {
      console.warn(`[warn] ${tool.name} ${installed} higher than pinned ${tool.version}; skip downgrade`);
      continue;
    }
    if (state === "equal") {
      // Ensure settings.json registration even if already installed
      const packages = await readSettingsPackages();
      if (!packages.includes(`npm:${tool.name}`)) {
        console.log(`[repair] registering npm:${tool.name} in pi settings.json`);
        await runPiInstall(tool);
        installedAny = true;
      }
      continue;
    }
    await runPiInstall(tool);
    installedAny = true;
  }

  const versions = await readInstalledVersions();
  await writeStateFile(versions);

  if (!installedAny) {
    console.log("[skip] managed pi extensions already match pinned versions");
  }
}

async function runStatus() {
  for (const tool of tools) {
    const installed = await readPackageVersion(tool.pkg);
    printStatusRow(rowForTool(tool, installed));
  }
}

async function runCompare() {
  for (const tool of tools) {
    const installed = await readPackageVersion(tool.pkg);
    printCompareRow(rowForTool(tool, installed));
  }
}

if (command === "init") {
  await runInstall();
} else if (command === "status") {
  await runStatus();
} else if (command === "compare") {
  await runCompare();
} else {
  throw new Error(`unknown command: ${command}`);
}
