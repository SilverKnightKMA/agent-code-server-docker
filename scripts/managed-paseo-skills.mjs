#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm, symlink, lstat, access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadManagedToolsConfig } from "./managed-tools-config.mjs";
import { actionForState, diagnosticForState, printCompareRow, printStatusRow } from "./managed-tools-output.mjs";

const execFileAsync = promisify(execFile);
const command = process.argv[2] ?? "status";
const repoRoot = path.resolve(import.meta.dirname, "..");

// ── Config ────────────────────────────────────────────────────────────────
const { manifest, policy } = await loadManagedToolsConfig(repoRoot);
const comparePolicy = policy.policy?.compare ?? {};
const family = manifest.families?.paseo_skills;
if (!family) throw new Error("managed-tools manifest missing paseo_skills family");

const tool = family.tools?.[0];
if (!tool) throw new Error("managed-tools manifest paseo_skills family has no tool");

// 2026-09-04: the expected skill set is derived dynamically from the canonical
// dir (~/.agents/skills) instead of a hardcoded list. Paseo renames/adds/removes
// skills between tags (e.g. paseo-loop -> paseo-help/paseo-plugin in v0.6.1),
// which made every hardcoded copy drift and fail with "canonical skill missing".
const CORE_SKILLS = ["paseo"]; // minimal sanity: a failed clone must not pass as ready

async function listSkills(dirPath) {
  if (!(await exists(dirPath))) return [];
  const out = [];
  for (const entry of await readdir(dirPath)) {
    if ((await exists(path.join(dirPath, entry, "SKILL.md")))) out.push(entry);
  }
  return out.sort();
}

// ── Paths ─────────────────────────────────────────────────────────────────
const home = os.homedir();
const canonicalSkillsDir = path.join(home, ".agents", "skills");
const statePath = path.join(home, ...family.statePath.replace(/^~\//, "").split("/"));
const stateFilePath = path.join(statePath, "installed-version.txt");

function expandTilde(p) {
  if (!p.startsWith("~")) return p;
  return path.join(home, p.slice(2));
}

function agentSkillDirs() {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const ompAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent");
  const configured = tool.agentDirs ?? [];
  if (configured.length > 0) {
    return configured.map((d) => {
      let expanded = expandTilde(d);
      expanded = expanded.replace(/^(.*)\/\.claude\/skills$/, path.join(claudeConfigDir, "skills"));
      expanded = expanded.replace(/^(.*)\/\.omp\/agent\/skills$/, path.join(ompAgentDir, "skills"));
      return expanded;
    });
  }
  return [
    path.join(claudeConfigDir, "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".pi", "agent", "skills"),
    path.join(ompAgentDir, "skills"),
    path.join(home, ".factory", "skills"),
    path.join(home, ".copilot", "skills"),
  ];
}

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
  if (!/^v?\d+(?:\.\d+){2}(?:[-+][A-Za-z0-9.-]+)?$/.test(installed)) return "unparseable";
  const cmp = compareVersions(installed, expected);
  if (cmp === 0) return "equal";
  if (cmp < 0) return "lower";
  return "higher";
}

function skillSource() {
  const source = tool.source ?? "https://github.com/getpaseo/paseo.git";
  return source.includes("#") ? source : `${source}#${tool.version}`;
}

// ── Status helpers ────────────────────────────────────────────────────────
async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Only ENOENT/ENOTDIR count as "target missing". fs.access also rejects
// with EACCES/EPERM for targets that exist but are unreadable by this
// process — treating those as missing would delete valid user-managed
// symlinks.
async function isDangling(target) {
  try {
    await access(target);
    return false;
  } catch (err) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR";
  }
}



async function skillsDirReady(dirPath, expected) {
  const found = await listSkills(dirPath);
  return expected.every((name) => found.includes(name)) && found.length > 0;
}

async function skillsReady() {
  // The canonical dir is the source of truth. Core-skill sanity first: a
  // partial/failed clone must never count as ready.
  const canonical = await listSkills(canonicalSkillsDir);
  if (!(CORE_SKILLS.every((name) => canonical.includes(name)) && canonical.length > 0)) {
    return false;
  }
  // Full completeness: every agent dir must contain the whole canonical
  // set (still no hardcoded names), so a partially linked agent dir
  // triggers reinstall instead of passing as ready.
  for (const dirPath of agentSkillDirs()) {
    if (!(await skillsDirReady(dirPath, canonical))) return false;
  }
  return true;
}

async function installedVersion() {
  if (!(await skillsReady())) return null;
  try {
    return (await readFile(stateFilePath, "utf8")).trim() || null;
  } catch {
    return "present-untracked";
  }
}

function rowForVersion(installed) {
  const state = compareState(installed, tool.version);
  return {
    family: "paseo_skills",
    tool: tool.name,
    desired: tool.version,
    actual: installed,
    path: canonicalSkillsDir,
    state,
    action: actionForState(comparePolicy, state),
    diagnostic: diagnosticForState(state, "paseo-skills"),
    source: "managed-tools-config",
  };
}

// ── Install helpers ───────────────────────────────────────────────────────
async function linkSkillsIntoAgents({ force } = {}) {
  if (!(await exists(canonicalSkillsDir))) return;
  const canonical = await listSkills(canonicalSkillsDir);
  // An empty canonical dir means the clone/checkout failed halfway. Never
  // sweep or link against it — but do NOT throw: runInstall() links before
  // installing precisely so the installer can self-heal by recloning, and an
  // abort here would block that repair path forever.
  if (canonical.length === 0) {
    console.warn(
      `[warn] canonical skills dir is empty: ${canonicalSkillsDir} — skipping link; installer will re-materialize`,
    );
    return;
  }
  for (const agentDir of agentSkillDirs()) {
    await mkdir(agentDir, { recursive: true });
    // Sweep first: remove only DANGLING symlinks — links whose target no
    // longer exists (e.g. a skill renamed/removed in canonical leaves its old
    // link behind). readdir + lstat so broken links (unreadable SKILL.md) are
    // caught; exists() guards against deleting valid user-managed symlinks
    // that simply point outside the canonical pack.
    for (const entry of await readdir(agentDir)) {
      const target = path.join(agentDir, entry);
      const stat = await lstat(target).catch(() => null);
      if (stat?.isSymbolicLink() && (await isDangling(target))) {
        await rm(target, { force: true });
      }
    }
    for (const name of canonical) {
      const source = path.join(canonicalSkillsDir, name);
      const target = path.join(agentDir, name);

      if (await exists(target)) {
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) {
          await rm(target, { force: true });
        } else if (force) {
          await rm(target, { recursive: true, force: true });
        } else {
          continue;
        }
      }
      await symlink(source, target);
    }
  }
}

async function runSkillsInstaller() {
  // The `skills` CLI (vercel-labs/skills) uses an interactive TUI that does not
  // reliably write files when spawned non-interactively (non-TTY) by a parent
  // process. Since the Paseo skills are plain directories with a SKILL.md, we
  // clone the pinned tag directly and materialize the canonical skill dir
  // ourselves. The agent-specific symlinks are handled by linkSkillsIntoAgents().
  console.log(`[install] cloning ${tool.repo} at ${tool.version}...`);
  const tmpDir = path.join(statePath, `clone-${Date.now()}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  try {
    await execFileAsync("git", [
      "clone", "--depth", "1", "--branch", tool.version,
      `https://github.com/${tool.repo}.git`, tmpDir,
    ], {
      cwd: statePath,
      env: { ...process.env, HOME: home },
      maxBuffer: 10 * 1024 * 1024,
    });
    // The repo stores skills in two locations: skills/ and .agents/skills/.
    // We merge both into the canonical ~/.agents/skills/ directory.
    const sourceDirs = [
      path.join(tmpDir, "skills"),
      path.join(tmpDir, ".agents", "skills"),
    ];

    await rm(canonicalSkillsDir, { recursive: true, force: true });
    await mkdir(canonicalSkillsDir, { recursive: true });
    for (const sourceDir of sourceDirs) {
      if (!(await exists(sourceDir))) continue;
      await execFileAsync("cp", ["-a", `${sourceDir}/.`, `${canonicalSkillsDir}/`], {
        cwd: tmpDir,
        env: { ...process.env, HOME: home },
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function runInstall() {
  const installed = await installedVersion();
  const state = compareState(installed, tool.version);
  if (state === "higher") {
    console.warn(`[warn] ${tool.name} ${installed} higher than pinned ${tool.version}; skip downgrade`);
    return;
  }
  if (state === "equal") {
    console.log("[skip] managed Paseo skills already match pinned version");
    return;
  }

  await mkdir(statePath, { recursive: true });

  // The skills CLI sometimes fails to materialize into every agent dir.
  // Link first to repair missing agent roots from an existing canonical copy.
  await linkSkillsIntoAgents({ force: true });

  if (!(await skillsReady())) {
    console.log("[install] installing Paseo skill pack via skills CLI...");
    await runSkillsInstaller();
    // Re-link after CLI install in case it only wrote the canonical dir.
    await linkSkillsIntoAgents({ force: true });
  }

  if (!(await skillsReady())) {
    throw new Error("paseo skills install completed but required skill roots are incomplete");
  }

  await mkdir(statePath, { recursive: true });
  await writeFile(stateFilePath, `${tool.version}\n`, "utf8");
}

async function runStatus() {
  printStatusRow(rowForVersion(await installedVersion()));
}

async function runCompare() {
  printCompareRow(rowForVersion(await installedVersion()));
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
