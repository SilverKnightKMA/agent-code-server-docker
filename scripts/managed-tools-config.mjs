import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatFields } from "./managed-tools-output.mjs";

const defaultBaseUrl = "https://raw.githubusercontent.com/SilverKnightKMA/agent-code-server-docker/main/managed-tools";
const configFiles = ["manifest.json", "policy.json"];
const defaultXdgCacheHome = path.join(os.homedir(), ".cache");

function normalizePath(value) {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function cacheDir() {
  const xdgCacheHome = process.env.XDG_CACHE_HOME ?? defaultXdgCacheHome;
  return normalizePath(process.env.AGENT_CODE_SERVER_CONFIG_CACHE_DIR
    ?? path.join(xdgCacheHome, "agent-code-server", "config"));
}

function configMode() {
  const mode = (process.env.AGENT_CODE_SERVER_MANAGED_TOOLS_CONFIG_MODE
    ?? process.env.AGENT_CODE_SERVER_CONFIG_SOURCE
    ?? "auto").toLowerCase();
  if (["auto", "online", "baked"].includes(mode)) return mode;
  throw new Error(`AGENT_CODE_SERVER_MANAGED_TOOLS_CONFIG_MODE must be auto, online, or baked; got ${mode}`);
}

function allowBakedFallback() {
  const val = process.env.AGENT_CODE_SERVER_MANAGED_TOOLS_ALLOW_BAKED_FALLBACK
    ?? process.env.AGENT_CODE_SERVER_ALLOW_BAKED_FALLBACK
    ?? "";
  return val === "true" || val === "1";
}

function normalizeBaseUrl(value) {
  const trimmed = value.replace(/\/+$/, "");
  const githubTree = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (!githubTree) return trimmed;
  const [, owner, repo, ref, directory] = githubTree;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${directory}`;
}

function configBaseUrl() {
  const url = process.env.AGENT_CODE_SERVER_MANAGED_TOOLS_BASE_URL
    ?? process.env.AGENT_CODE_SERVER_CONFIG_BASE_URL
    ?? defaultBaseUrl;
  return normalizeBaseUrl(url);
}

function fetchTimeoutMs() {
  const raw = process.env.AGENT_CODE_SERVER_CONFIG_TIMEOUT_MS ?? "5000";
  const timeout = Number.parseInt(raw, 10);
  if (Number.isFinite(timeout) && timeout > 0) return timeout;
  throw new Error(`AGENT_CODE_SERVER_CONFIG_TIMEOUT_MS must be a positive integer; got ${raw}`);
}

function parseConfig(text, fileName, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}/${fileName} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source}/${fileName} must be a JSON object`);
  }
  if (fileName === "manifest.json" && !parsed.families) {
    throw new Error(`${source}/${fileName} missing families`);
  }
  if (fileName === "policy.json" && !parsed.policy) {
    throw new Error(`${source}/${fileName} missing policy`);
  }
  return parsed;
}

async function readConfigDirectory(directory, source) {
  const files = await Promise.all(configFiles.map(async (fileName) => {
    const text = await readFile(path.join(directory, fileName), "utf8");
    return [fileName, { text, parsed: parseConfig(text, fileName, source) }];
  }));
  return Object.fromEntries(files);
}

async function fetchConfigFile(baseUrl, fileName, timeoutMs) {
  const url = `${baseUrl}/${fileName}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "agent-code-server-managed-tools" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    return { text, parsed: parseConfig(text, fileName, url) };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw new Error(`${url} fetch failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOnlineConfig() {
  const baseUrl = configBaseUrl();
  const timeout = fetchTimeoutMs();
  const files = await Promise.all(configFiles.map(async (fileName) => [fileName, await fetchConfigFile(baseUrl, fileName, timeout)]));
  return { source: "online", baseUrl, files: Object.fromEntries(files) };
}

async function readCachedConfig() {
  return { source: "cache", directory: cacheDir(), files: await readConfigDirectory(cacheDir(), "managed-tools-cache") };
}

async function readBakedConfig(repoRoot) {
  const directory = path.join(repoRoot, "managed-tools");
  return { source: "baked", directory, files: await readConfigDirectory(directory, "managed-tools-baked") };
}

async function writeCache(files) {
  const directory = cacheDir();
  await mkdir(directory, { recursive: true });
  await Promise.all(configFiles.map((fileName) => writeFile(path.join(directory, fileName), files[fileName].text)));
}

function warnConfigFailure(source, error) {
  console.warn(`[warn] ${formatFields({ family: "managed-tools-config", source, result: "failed", diagnostic: error.message })}`);
}

function logConfig(result, mode, fallback) {
  console.log(`[config] ${formatFields({
    source: result.source,
    mode,
    fallback: fallback ?? "no",
    base_url: result.baseUrl,
    directory: result.directory,
    cache_dir: result.source === "online" ? cacheDir() : undefined,
  })}`);
}

export async function loadManagedToolsConfig(repoRoot) {
  const mode = configMode();
  const allowBaked = allowBakedFallback();

  if (mode === "baked") {
    const result = await readBakedConfig(repoRoot);
    logConfig(result, mode, "no");
    return { manifest: result.files["manifest.json"].parsed, policy: result.files["policy.json"].parsed, source: result.source };
  }

  try {
    const result = await fetchOnlineConfig();
    try {
      await writeCache(result.files);
    } catch (error) {
      warnConfigFailure("cache-write", error);
    }
    logConfig(result, mode, "no");
    return { manifest: result.files["manifest.json"].parsed, policy: result.files["policy.json"].parsed, source: result.source };
  } catch (error) {
    warnConfigFailure("online", error);
    if (mode === "online") throw error;
    // auto mode: hard-fail unless explicitly allowed to fall back to baked
    if (!allowBaked && mode !== "baked") {
      throw new Error(`[config] online config fetch failed and baked fallback is not enabled. `
        + `Set AGENT_CODE_SERVER_MANAGED_TOOLS_ALLOW_BAKED_FALLBACK=true to use baked config as an offline fallback.`);
    }
  }

  // Fallback path: only reached when allowBakedFallback is true
  try {
    const result = await readCachedConfig();
    logConfig(result, mode, "cache");
    return { manifest: result.files["manifest.json"].parsed, policy: result.files["policy.json"].parsed, source: result.source };
  } catch (error) {
    warnConfigFailure("cache", error);
  }

  const result = await readBakedConfig(repoRoot);
  logConfig(result, mode, "baked");
  return { manifest: result.files["manifest.json"].parsed, policy: result.files["policy.json"].parsed, source: result.source };
}
