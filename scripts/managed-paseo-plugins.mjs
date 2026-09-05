#!/usr/bin/env node
/**
 * managed-paseo-plugins.mjs — paseo_plugins family.
 *
 * Paseo's own CLI already understands git-sourced plugins with a pinned ref
 * (`paseo plugin install <repo>:<plugin> --ref <tag>`), keeps its checkout
 * under ~/.paseo/plugins/<id>/<commit>-<uuid>/checkout, and reports source
 * truth via `paseo plugin status --json` (source/git/ref/currentCommit). So
 * unlike the pi-extension pack there is no separate state file: the daemon
 * config IS the state and this script only reconciles refs against the
 * manifest pin. `paseo plugin update` is intentionally never used — the
 * manifest pin is the single source of truth for versions.
 *
 * Status resolution per tool:
 *   - every plugin id in tool.plugins must exist with source "git",
 *     remote matching tool.repo, and ref == tool.version → equal
 *   - any missing id → missing; any older ref → lower; any newer → higher
 *
 * Install: installs each plugin at the pinned ref; takes over ids that exist
 * with a different source (e.g. a dev directory install) via remove+install.
 * Daemon-unreachable during init (fresh container, daemon not started yet)
 * degrades to a warning instead of failing the whole init pass.
 */
import { execFile } from "node:child_process";
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
const family = manifest.families?.paseo_plugins;
if (!family) throw new Error("managed-tools manifest missing paseo_plugins family");
if ((family.tools ?? []).length === 0) throw new Error("paseo_plugins family has no tools");

const home = os.homedir();
const paseoPluginsDir = path.join(home, ".paseo", "plugins");

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

// ── Daemon plugin status ──────────────────────────────────────────────────
async function pluginStatusIndex() {
  try {
    const { stdout } = await execFileAsync("paseo", ["plugin", "status", "--json"], {
      env: { ...process.env, HOME: home },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    const list = JSON.parse(stdout);
    const index = new Map();
    for (const entry of Array.isArray(list) ? list : []) index.set(entry.id, entry);
    return index;
  } catch (error) {
    throw new Error(`paseo plugin status failed (daemon reachable?): ${error.message}`);
  }
}

function resolveToolState(tool, index) {
  const refs = [];
  for (const pluginId of tool.plugins ?? []) {
    const entry = index.get(pluginId);
    if (!entry || entry.source !== "git") return { state: "missing", refs };
    if (!String(entry.remote ?? "").includes(tool.repo)) return { state: "missing", refs };
    refs.push(String(entry.ref ?? ""));
  }
  if (refs.some((ref) => !ref)) return { state: "unparseable", refs };
  let state = "equal";
  for (const ref of refs) {
    const cmp = compareVersions(ref, tool.version);
    if (cmp < 0) state = "lower";
    else if (cmp > 0 && state === "equal") state = "higher";
  }
  return { state, refs };
}

function rowForTool(tool, state, refs) {
  const uniqueRefs = [...new Set(refs)];
  return {
    family: "paseo_plugins",
    tool: tool.name,
    desired: tool.version,
    actual: uniqueRefs.length === 0 ? null : uniqueRefs.join("|"),
    path: paseoPluginsDir,
    state,
    action: actionForState(comparePolicy, state),
    diagnostic: diagnosticForState(state, "paseo-plugin"),
    source: "managed-tools-config",
  };
}

// ── Install ───────────────────────────────────────────────────────────────
async function installPlugin(tool, pluginId) {
  await execFileAsync("paseo", [
    "plugin", "install",
    `https://github.com/${tool.repo}:${pluginId}`,
    "--ref", tool.version,
  ], {
    env: { ...process.env, HOME: home },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
}

async function runInstall() {
  let installedAny = false;
  let index;
  try {
    index = await pluginStatusIndex();
  } catch (error) {
    console.warn(`[warn] ${error.message} — plugin installs skipped this pass`);
    return;
  }
  for (const tool of family.tools) {
    for (const pluginId of tool.plugins ?? []) {
      const entry = index.get(pluginId);
      const matches = entry
        && entry.source === "git"
        && String(entry.remote ?? "").includes(tool.repo)
        && String(entry.ref ?? "") === tool.version;
      if (matches) continue;
      if (entry) {
        console.log(`[takeover] removing existing ${pluginId} (source ${entry.source}, ref ${entry.ref ?? "-"})`);
        try {
          await execFileAsync("paseo", ["plugin", "remove", pluginId], {
            env: { ...process.env, HOME: home },
            maxBuffer: 1 * 1024 * 1024,
            timeout: 30_000,
          });
        } catch (error) {
          console.warn(`[warn] remove ${pluginId} failed: ${error.message}`);
          continue;
        }
      }
      console.log(`[install] ${pluginId} @ ${tool.repo} ${tool.version}`);
      try {
        await installPlugin(tool, pluginId);
        installedAny = true;
      } catch (error) {
        console.warn(`[warn] install ${pluginId} failed: ${error.message}`);
      }
    }
  }
  if (!installedAny) console.log("[skip] managed paseo plugins already match pinned refs");
}

async function withIndex(fn) {
  try {
    return fn(await pluginStatusIndex());
  } catch (error) {
    console.warn(`[warn] ${error.message}`);
    return null;
  }
}

async function runStatus() {
  for (const tool of family.tools) {
    const row = await withIndex(async (index) => {
      const { state, refs } = resolveToolState(tool, index);
      return rowForTool(tool, state, refs);
    });
    if (row) printStatusRow(row);
  }
}

async function runCompare() {
  for (const tool of family.tools) {
    const row = await withIndex(async (index) => {
      const { state, refs } = resolveToolState(tool, index);
      return rowForTool(tool, state, refs);
    });
    if (row) printCompareRow(row);
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
