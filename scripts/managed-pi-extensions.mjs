#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm, readdir, lstat } from "node:fs/promises";
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
const piExtensionsDir = path.join(piAgentDir, "extensions");
const statePath = path.join(home, ...family.statePath.replace(/^~\//, "").split("/"));
const stateFilePath = path.join(statePath, "installed-versions.json");
const dirsFilePath = path.join(statePath, "installed-dirs.json");
const piSkillsDir = path.join(piAgentDir, "skills");

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
    if (tool.sourceType === "github") {
      versions[tool.name] = await readPackVersion(tool);
    } else {
      versions[tool.name] = await readPackageVersion(tool.pkg);
    }
  }
  return versions;
}

async function writeStateFile(versions) {
  await mkdir(statePath, { recursive: true });
  await writeFile(stateFilePath, JSON.stringify(versions, null, 2) + "\n", "utf8");
}

// ── GitHub-source packs (sourceType: "github") ───────────────────────────
// A pack is a git repo whose <extensionRoot> holds extension entries
// (directories and/or top-level .ts files). We clone the pinned tag and copy
// entries into ~/.pi/agent/extensions/. Only entries recorded in our own
// state file are ever swept — untracked files/dirs are user property and are
// never touched (mirrors the paseo_skills untracked-safety rule).

async function readDirsState() {
  try {
    return JSON.parse(await readFile(dirsFilePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeDirsState(dirs) {
  await mkdir(statePath, { recursive: true });
  await writeFile(dirsFilePath, JSON.stringify(dirs, null, 2) + "\n", "utf8");
}

async function packEntriesPresent(entries) {
  return packEntriesPresentUnder(piExtensionsDir, entries);
}

async function packEntriesPresentUnder(baseDir, entries) {
  for (const entry of entries) {
    try {
      await lstat(path.join(baseDir, entry));
    } catch {
      return false;
    }
  }
  return true;
}

const skillsKeyFor = (tool) => `${tool.name}::skills`;

async function readPackVersion(tool) {
  const dirs = await readDirsState();
  const entries = dirs[tool.name];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (!(await packEntriesPresent(entries))) return null;
  // Skill entries ride the same pack tag — if the pack installed skills,
  // they must all be present too, else the pack is not whole.
  const skillEntries = dirs[skillsKeyFor(tool)];
  if (Array.isArray(skillEntries) && skillEntries.length > 0) {
    if (!(await packEntriesPresentUnder(piSkillsDir, skillEntries))) return null;
  }
  // Raw state-file read, NOT readInstalledVersions(): that helper calls
  // readPackVersion for github tools — calling it back from here is infinite
  // mutual recursion once the pack is installed (2026-09-04 hang: first init
  // succeeds, every later init/status/compare spins forever).
  try {
    const raw = JSON.parse(await readFile(stateFilePath, "utf8"));
    return raw[tool.name] ?? null;
  } catch {
    return null;
  }
}

async function installGithubPack(tool) {
  const extensionRoot = tool.extensionRoot ?? "extensions";
  console.log(`[install] cloning ${tool.repo} at ${tool.version} (pi extension pack)...`);
  const tmpDir = path.join(statePath, `clone-${Date.now()}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  let entries;
  let skillEntries = [];
  try {
    await execFileAsync("git", [
      "clone", "--depth", "1", "--branch", tool.version,
      `https://github.com/${tool.repo}.git`, tmpDir,
    ], {
      cwd: statePath,
      env: { ...process.env, HOME: home },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    const rootDir = path.join(tmpDir, extensionRoot);
    entries = (await readdir(rootDir, { withFileTypes: true }))
      // v2-layout guard (2026-09-04 incident): loader scans level-1 *.ts AND
      // */index.ts — *.test.ts at level 1 kills pi ("bun:test" not found), and
      // `cp -a src dst` with existing dst nests dirs (x/x/). Only directories
      // ride the pack; a flat .ts must be named in tool.entryFiles if ever
      // needed. Entries install by rm-then-cp so reruns never nest.
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (entries.length === 0) {
      throw new Error(`${tool.repo}@${tool.version} has no entries under ${extensionRoot}/`);
    }
    // Optional skill root (manifest skillRoot): each dir installs to
    // ~/.pi/agent/skills/<name> with the same rm-then-cp discipline.
    if (tool.skillRoot) {
      const skillRootDir = path.join(tmpDir, tool.skillRoot);
      try {
        skillEntries = (await readdir(skillRootDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        skillEntries = [];
      }
    }
    await mkdir(piExtensionsDir, { recursive: true });
    for (const entry of entries) {
      const dst = path.join(piExtensionsDir, entry);
      // Preserve a live node_modules across rm-then-cp (repo never carries it):
      // dev containers keep their installed deps; npm install below verifies
      // them against the freshly copied package.json.
      const liveNm = path.join(dst, "node_modules");
      let preservedNm = null;
      try {
        if ((await lstat(liveNm)).isDirectory()) {
          preservedNm = path.join(piExtensionsDir, `.tmp-pack-nm-${entry}-${Date.now()}`);
          await execFileAsync("mv", [liveNm, preservedNm], { timeout: 60_000 });
        }
      } catch {
        // no live node_modules — nothing to preserve
      }
      await rm(dst, { recursive: true, force: true });
      await execFileAsync("cp", ["-a", path.join(rootDir, entry), dst], {
        cwd: tmpDir,
        env: { ...process.env, HOME: home },
        timeout: 60_000,
      });
      if (preservedNm) {
        await execFileAsync("mv", [preservedNm, liveNm], { timeout: 60_000 });
      }
      // Flat-file collision guard: a legacy root-level <entry>.ts would
      // double-load against <entry>/ and crash pi with a tool/command
      // conflict (md-log.ts -> md-log/ migration, 2026-09-05).
      const flatFile = `${dst}.ts`;
      try {
        await lstat(flatFile);
        await rm(flatFile, { force: true });
        console.log(`[sweep] removed flat ${entry}.ts (collides with dir ${entry}/)`);
      } catch {
        // absent — nothing to do
      }
      // Runtime deps: entries carrying package.json with dependencies get
      // npm install'd (own pinned postinstall scripts included — puppeteer
      // browser download for mermaid-cli). Preserved node_modules make this
      // a fast verify; fresh containers pay the one-time download.
      try {
        const pkgJson = JSON.parse(await readFile(path.join(dst, "package.json"), "utf8"));
        if (pkgJson.dependencies && Object.keys(pkgJson.dependencies).length > 0) {
          console.log(`[install] ${entry}: npm install (runtime deps)`);
          await execFileAsync("npm", [
            "install", "--prefix", dst, "--no-audit", "--no-fund",
          ], {
            cwd: dst,
            env: { ...process.env, HOME: home },
            maxBuffer: 10 * 1024 * 1024,
            timeout: 600_000,
          });
        }
      } catch (err) {
        console.warn(`[warn] ${entry}: npm install failed — ${err.message}`);
      }
    }
    if (skillEntries.length > 0) {
      await mkdir(piSkillsDir, { recursive: true });
      for (const entry of skillEntries) {
        const dst = path.join(piSkillsDir, entry);
        await rm(dst, { recursive: true, force: true });
        await execFileAsync("cp", ["-a", path.join(tmpDir, tool.skillRoot, entry), dst], {
          cwd: tmpDir,
          env: { ...process.env, HOME: home },
          timeout: 60_000,
        });
        console.log(`[install] skills/${entry}/`);
      }
    }
    // Production installs carry no test files (any depth) and no E2E junk.
    await execFileAsync("find", [piExtensionsDir, "-name", "*.test.ts", "-delete"], { timeout: 30_000 });
    await execFileAsync("find", [piExtensionsDir, "-name", ".tmp-*", "-exec", "rm", "-rf", "{}", "+"], { timeout: 30_000 });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // Sweep: entries installed by a PREVIOUS tag of this pack but absent from
  // the new one (renamed/removed extension/skill). Recorded-only, never
  // untracked (mirrors the paseo_skills untracked-safety rule).
  const dirs = await readDirsState();
  const previous = Array.isArray(dirs[tool.name]) ? dirs[tool.name] : [];
  for (const gone of previous.filter((e) => !entries.includes(e))) {
    console.log(`[sweep] removing ${gone} (absent from ${tool.version})`);
    await rm(path.join(piExtensionsDir, gone), { recursive: true, force: true });
  }
  const skillsKey = skillsKeyFor(tool);
  const previousSkills = Array.isArray(dirs[skillsKey]) ? dirs[skillsKey] : [];
  for (const gone of previousSkills.filter((e) => !skillEntries.includes(e))) {
    console.log(`[sweep] removing skills/${gone} (absent from ${tool.version})`);
    await rm(path.join(piSkillsDir, gone), { recursive: true, force: true });
  }

  dirs[tool.name] = entries;
  if (skillEntries.length > 0) {
    dirs[skillsKey] = skillEntries;
  } else {
    delete dirs[skillsKey];
  }
  await writeDirsState(dirs);

  const versions = await readInstalledVersions();
  versions[tool.name] = tool.version;
  await writeStateFile(versions);
}

// ── Row helpers ───────────────────────────────────────────────────────────
async function installedVersionFor(tool) {
  return tool.sourceType === "github" ? readPackVersion(tool) : readPackageVersion(tool.pkg);
}

function rowForTool(tool, installed) {
  const desired = tool.version;
  const state = compareState(installed, desired);
  return {
    family: "pi_extensions",
    tool: tool.name,
    desired,
    actual: installed,
    path: tool.sourceType === "github" ? piExtensionsDir : path.join(piNpmDir, "node_modules", tool.pkg),
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
    if (tool.sourceType === "github") {
      const installed = await readPackVersion(tool);
      const state = compareState(installed, tool.version);
      if (state === "higher") {
        console.warn(`[warn] ${tool.name} ${installed} higher than pinned ${tool.version}; skip downgrade`);
        continue;
      }
      if (state === "equal") {
        continue;
      }
      await installGithubPack(tool);
      installedAny = true;
      continue;
    }
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
    printStatusRow(rowForTool(tool, await installedVersionFor(tool)));
  }
}

async function runCompare() {
  for (const tool of tools) {
    printCompareRow(rowForTool(tool, await installedVersionFor(tool)));
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
