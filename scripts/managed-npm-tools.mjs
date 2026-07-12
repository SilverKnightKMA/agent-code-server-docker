#!/usr/bin/env node
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadManagedToolsConfig } from "./managed-tools-config.mjs";
import { actionForState, diagnosticForState, printCompareRow, printStatusRow } from "./managed-tools-output.mjs";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJsonPath = path.join(repoRoot, "package.json");

const command = process.argv[2] ?? "status";
const selectedTools = process.argv.slice(3);
const installPath = normalizePath(process.env.MANAGED_NPM_PREFIX ?? process.env.NPM_CONFIG_PREFIX ?? "~/.npm-global");

const { manifest, policy } = await loadManagedToolsConfig(repoRoot);
const npmFamily = manifest.families?.npm;

if (!npmFamily) {
  throw new Error("managed-tools manifest missing npm family");
}

const tools = npmFamily.tools ?? [];
const comparePolicy = policy.policy?.compare ?? {};
const packageJson = JSON.parse(await readFile(rootPackageJsonPath, "utf8"));

function bundleFor(selected) {
  return {
    name: `${packageJson.name}-managed-npm-bundle`,
    private: true,
    license: packageJson.license,
    packageManager: packageJson.packageManager,
    dependencies: Object.fromEntries(selected.map((tool) => [tool.pkg, tool.version])),
  };
}

function normalizePath(value) {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function stripPrefix(version) {
  return String(version).replace(/^v/, "");
}

async function npmList(prefix) {
  if (!(await exists(prefix))) {
    return { dependencies: {} };
  }
  const { stdout } = await execFileAsync("npm", ["list", "--depth=0", "--json", "--prefix", prefix], {
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function installedVersion(prefix, pkg) {
  const tree = await npmList(prefix);
  return tree?.dependencies?.[pkg]?.version ?? null;
}

function compareState(installed, expected) {
  if (!installed) return "missing";
  const normalizedInstalled = stripPrefix(installed);
  const normalizedExpected = stripPrefix(expected);
  const diff = compareVersions(normalizedInstalled, normalizedExpected);
  if (diff === 0) return "equal";
  if (diff < 0) return "lower";
  return "higher";
}

function desiredVersionForTool(tool) {
  if (!tool.version) throw new Error(`${tool.name} missing version in managed-tools manifest`);
  return tool.version;
}

function selectedToolList() {
  if (selectedTools.length === 0) return tools;
  const selected = tools.filter((tool) => selectedTools.includes(tool.name) || selectedTools.includes(tool.pkg));
  if (selected.length === 0) {
    throw new Error(`unknown npm managed tool selection: ${selectedTools.join(", ")}`);
  }
  return selected;
}

async function ensureBundleFiles(tmpDir, selected) {
  await writeFile(path.join(tmpDir, "package.json"), JSON.stringify(bundleFor(selected), null, 2) + "\n");
  await rm(path.join(tmpDir, "package-lock.json"), { force: true });
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function exposeBins(selected) {
  const binDir = path.join(installPath, "bin");
  await mkdir(binDir, { recursive: true });

  for (const tool of selected) {
    const installedPackageJsonPath = path.join(installPath, "node_modules", tool.pkg, "package.json");
    if (!(await exists(installedPackageJsonPath))) continue;
    const installedPackage = JSON.parse(await readFile(installedPackageJsonPath, "utf8"));
    const bins = typeof installedPackage.bin === "string" ? { [tool.name]: installedPackage.bin } : (installedPackage.bin ?? {});
    for (const [binName, target] of Object.entries(bins)) {
      const source = path.join(installPath, "node_modules", tool.pkg, target);
      if (!(await exists(source))) continue;
      const destination = path.join(binDir, binName);
      await rm(destination, { force: true });
      await symlink(path.relative(binDir, source), destination);
    }
  }
}

async function runPostinstallScripts(selected) {
  for (const tool of selected) {
    if (!tool.needsPostinstall) continue;
    const pkgDir = path.join(installPath, "node_modules", tool.pkg);
    const installedPackageJsonPath = path.join(pkgDir, "package.json");
    if (!(await exists(installedPackageJsonPath))) continue;
    const installedPackage = JSON.parse(await readFile(installedPackageJsonPath, "utf8"));
    const postinstall = installedPackage.scripts?.postinstall;
    if (!postinstall) continue;
    console.log(`[postinstall] ${tool.name} (${tool.pkg}): ${postinstall}`);
    await execFileAsync("sh", ["-c", postinstall], {
      cwd: pkgDir,
      env: { ...process.env, npm_config_prefix: installPath },
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

async function runInstall() {
  const selected = selectedToolList();
  let hasInstallWork = false;
  for (const tool of selected) {
    const installed = await installedVersion(installPath, tool.pkg);
    const desired = desiredVersionForTool(tool);
    const state = compareState(installed, desired);
    if (state === "higher") {
      console.warn(`[warn] ${tool.name} ${installed} higher than pinned ${desired}; skip downgrade`);
      return;
    }
    if (state === "missing" || state === "lower") {
      hasInstallWork = true;
    }
  }

  if (!hasInstallWork) {
    console.log("[skip] npm managed tools already match pinned versions");
    return;
  }

  await mkdir(installPath, { recursive: true });
  await ensureBundleFiles(installPath, selected);
  await execFileAsync("npm", ["install", "--ignore-scripts", "--prefix", installPath], {
    env: { ...process.env, NPM_CONFIG_PREFIX: installPath },
    maxBuffer: 10 * 1024 * 1024,
  });
  // A handful of tools (native-binary agent CLIs) rely on their own postinstall
  // to select/wire up the platform-specific binary; --ignore-scripts above
  // skips that for everyone, so run it back explicitly for just those tools.
  await runPostinstallScripts(selected);
  await exposeBins(selected);

  await rm(path.join(installPath, "package.json"), { force: true });
  await rm(path.join(installPath, "package-lock.json"), { force: true });
}

function rowForTool(tool, installed) {
  const desired = desiredVersionForTool(tool);
  const state = compareState(installed, desired);
  return {
    family: "npm",
    tool: tool.name,
    desired,
    actual: installed,
    path: path.join(installPath, "node_modules", tool.pkg),
    state,
    action: actionForState(comparePolicy, state),
    diagnostic: diagnosticForState(state, "npm-package"),
    source: "managed-tools-config",
  };
}

async function runStatus() {
  for (const tool of selectedToolList()) {
    const installed = await installedVersion(installPath, tool.pkg);
    printStatusRow(rowForTool(tool, installed));
  }
}

async function runCompare() {
  for (const tool of selectedToolList()) {
    const installed = await installedVersion(installPath, tool.pkg);
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
