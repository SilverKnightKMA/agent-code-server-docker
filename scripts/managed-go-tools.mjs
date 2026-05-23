#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadManagedToolsConfig } from "./managed-tools-config.mjs";
import { actionForState, diagnosticForState, formatFields, printCompareRow, printStatusRow } from "./managed-tools-output.mjs";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const command = process.argv[2] ?? "status";
const { manifest, policy } = await loadManagedToolsConfig(repoRoot);
const goToolchainFamily = manifest.families?.go_toolchain;
const goToolsFamily = manifest.families?.go_tools;

if (!goToolchainFamily) throw new Error("managed-tools manifest missing go_toolchain family");
if (!goToolsFamily) throw new Error("managed-tools manifest missing go_tools family");

const goToolchain = goToolchainFamily.tools?.[0];
if (!goToolchain) throw new Error("managed-tools manifest missing go toolchain entry");

const goRoot = normalizePath(process.env.MANAGED_GO_ROOT ?? goToolchainFamily.installPath);
const goBin = normalizePath(process.env.GOBIN ?? goToolsFamily.gobin ?? goToolsFamily.installPath);
const goBinary = process.env.MANAGED_GO_BINARY ?? path.join(goRoot, "bin", "go");
const tempRoot = managedTempRoot();
const tools = goToolsFamily.tools ?? [];
const comparePolicy = policy.policy?.compare ?? {};

function normalizePath(value) {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function managedTempRoot() {
  return normalizePath(process.env.OPENCHAMBER_MANAGED_TOOLS_TMPDIR
    ?? process.env.MANAGED_TOOLS_TMPDIR
    ?? process.env.TMPDIR
    ?? "~/.cache/openchamber-managed/tmp");
}

async function makeTempDir(prefix) {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, prefix));
}

function logRuntimeState() {
  console.log(`[state] ${formatFields({
    command,
    filters: "go",
    go_root: goRoot,
    go_bin: goBin,
    go_binary: goBinary,
    temp_root: tempRoot,
  })}`);
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

function stripPrefix(version) {
  return String(version).replace(/^v/, "");
}

function compareVersions(left, right) {
  const leftParts = stripPrefix(left).split(/[.-]/);
  const rightParts = stripPrefix(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function compareState(installed, expected) {
  if (!installed) return "missing";
  const diff = compareVersions(installed, expected);
  if (diff === 0) return "equal";
  if (diff < 0) return "lower";
  return "higher";
}

function toolchainArchiveName() {
  return goToolchain.assetPattern.replace("{version}", goToolchain.version);
}

async function resolveToolchainMetadata() {
  const metadataUrl = goToolchainFamily.checksumUrlPattern;
  console.log(`[fetch] ${formatFields({ tool: "go", version: goToolchain.version, target: "go-release-metadata" })}`);
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`failed to fetch ${metadataUrl}: ${response.status} ${response.statusText}`);
  const releases = await response.json();
  const archiveName = toolchainArchiveName();
  for (const release of releases) {
    for (const file of release.files ?? []) {
      if (file.filename === archiveName) {
        if (!file.sha256) throw new Error(`${archiveName} missing sha256 in Go metadata`);
        console.log(`[fetch] ${formatFields({
          tool: "go",
          release_tag: release.version,
          asset: archiveName,
          size: file.size,
          target: "go-release-metadata",
        })}`);
        return { archiveName, sha256: file.sha256, size: file.size, url: `https://go.dev/dl/${archiveName}` };
      }
    }
  }
  throw new Error(`${archiveName} not found in Go metadata ${metadataUrl}`);
}

async function downloadFile(url, destination, fields = {}) {
  console.log(`[download] ${formatFields({ ...fields, target: destination })}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
  await pipeline(response.body, createWriteStream(destination));
  console.log(`[download] ${formatFields({ ...fields, target: destination, status: "complete" })}`);
}

async function clearDirectoryContents(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  await Promise.all(entries.map((entry) => rm(path.join(directoryPath, entry.name), { recursive: true, force: true })));
}

async function removeGoRoot(goRootPath) {
  try {
    await rm(goRootPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "EBUSY") throw error;
    console.warn(`[warn] ${formatFields({ target: goRootPath, reason: "go-root is a mountpoint; clearing contents instead of removing" })}`);
    await clearDirectoryContents(goRootPath);
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const file = createReadStream(filePath);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest("hex");
}

async function installedGoVersion() {
  if (!(await exists(goBinary))) return null;
  try {
    const { stdout } = await execFileAsync(goBinary, ["version"], { env: { ...process.env } });
    const match = stdout.match(/go version go([^\s]+)/);
    return match?.[1] ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function installToolchain() {
  const installed = await installedGoVersion();
  const state = compareState(installed, goToolchain.version);
  if (state === "equal") {
    console.log(`[skip] go ${installed} matches pinned ${goToolchain.version}`);
    return;
  }
  if (state === "higher") {
    console.warn(`[warn] go ${installed} higher than pinned ${goToolchain.version}; skip downgrade`);
    return;
  }

  const metadata = await resolveToolchainMetadata();
  const tempDir = await makeTempDir("managed-go-");
  const archivePath = path.join(tempDir, metadata.archiveName);
  try {
    await downloadFile(metadata.url, archivePath, { tool: "go", asset: metadata.archiveName, size: metadata.size });
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== metadata.sha256) {
      throw new Error(`${metadata.archiveName} sha256 mismatch: expected ${metadata.sha256}, got ${actualSha256}`);
    }
    console.log(`[verify] ${formatFields({ tool: "go", asset: metadata.archiveName, sha256: metadata.sha256, target: archivePath })}`);
    await removeGoRoot(goRoot);
    await mkdir(path.dirname(goRoot), { recursive: true });
    console.log(`[extract] ${formatFields({ archive: metadata.archiveName, target: path.dirname(goRoot) })}`);
    await execFileAsync("tar", ["-C", path.dirname(goRoot), "-xzf", archivePath], { env: { ...process.env } });
    console.log(`[extract] ${formatFields({ archive: metadata.archiveName, target: path.dirname(goRoot), status: "complete" })}`);
    const extractedRoot = path.join(path.dirname(goRoot), "go");
    if (extractedRoot !== goRoot) {
      await removeGoRoot(goRoot);
      await rename(extractedRoot, goRoot);
    }
    console.log(`[install] ${formatFields({ tool: "go", version: goToolchain.version, target: goRoot })}`);
    console.log(`[install] go ${goToolchain.version} installed to ${goRoot}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function installedGoToolVersion(tool) {
  const binaryPath = path.join(goBin, tool.name);
  if (!(await exists(binaryPath))) return null;
  try {
    const { stdout } = await execFileAsync(goBinary, ["version", "-m", binaryPath], {
      env: { ...process.env, PATH: `${path.dirname(goBinary)}:${process.env.PATH ?? ""}` },
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = stdout.split("\n");
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === "mod" && fields[1] === tool.pkg && fields[2]) return fields[2];
      if (fields[0] === "mod" && tool.pkg.startsWith(`${fields[1]}/`) && fields[2]) return fields[2];
    }
    return "unparseable";
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function toolRows() {
  const rows = [];
  for (const tool of tools) {
    const expected = tool.version;
    if (!expected) throw new Error(`${tool.name} missing version in managed-tools manifest`);
    const installed = await installedGoToolVersion(tool);
    const state = installed === "unparseable" ? "unparseable" : compareState(installed, expected);
    rows.push({
      family: "go_tools",
      tool: tool.name,
      toolDefinition: tool,
      desired: expected,
      expected,
      actual: installed,
      installed,
      path: path.join(goBin, tool.name),
      state,
      action: actionForState(comparePolicy, state),
      diagnostic: diagnosticForState(state, "go-tool"),
      source: "managed-tools-config+go-version-m",
    });
  }
  return rows;
}

async function toolchainRow() {
  const goInstalled = await installedGoVersion();
  const goState = compareState(goInstalled, goToolchain.version);
  return {
    family: "go_toolchain",
    tool: "go",
    desired: goToolchain.version,
    actual: goInstalled,
    path: goBinary,
    state: goState,
    action: actionForState(comparePolicy, goState),
    diagnostic: diagnosticForState(goState, "go-toolchain"),
    source: "go-version",
  };
}

async function printRows(printer) {
  printer(await toolchainRow());
  for (const row of await toolRows()) {
    printer(row);
  }
}

async function installGoTools() {
  await mkdir(goBin, { recursive: true });
  for (const row of await toolRows()) {
    if (row.state === "higher") {
      console.warn(`[warn] ${row.tool} ${row.installed} higher than pinned ${row.expected}; skip downgrade`);
      continue;
    }
    if (row.state === "unparseable") {
      console.warn(`[warn] ${row.tool} version unparseable from go version -m; skip`);
      continue;
    }
    if (row.state === "equal") {
      console.log(`[skip] ${row.tool} ${row.installed} matches pinned ${row.expected}`);
      continue;
    }
    console.log(`[install] ${formatFields({ tool: row.tool, version: row.expected, pkg: row.toolDefinition.pkg, target: path.join(goBin, row.tool) })}`);
    await execFileAsync(goBinary, ["install", `${row.toolDefinition.pkg}@${row.expected}`], {
      cwd: repoRoot,
      env: { ...process.env, GOBIN: goBin, PATH: `${path.dirname(goBinary)}:${process.env.PATH ?? ""}` },
      maxBuffer: 10 * 1024 * 1024,
    });
    const binaryPath = path.join(goBin, row.tool);
    if (await exists(binaryPath)) await chmod(binaryPath, 0o755);
    console.log(`[install] ${row.tool} ${row.expected} installed to ${goBin}`);
  }
}

async function runInit() {
  await installToolchain();
  await installGoTools();
}

if (command === "init") {
  logRuntimeState();
  await runInit();
} else if (command === "status") {
  logRuntimeState();
  await printRows(printStatusRow);
} else if (command === "compare") {
  logRuntimeState();
  await printRows(printCompareRow);
} else if (command === "toolchain") {
  logRuntimeState();
  await installToolchain();
} else if (command === "tools") {
  logRuntimeState();
  await installGoTools();
} else {
  console.error("usage: managed-go-tools.mjs [init|status|compare|toolchain|tools]");
  process.exitCode = 2;
}
