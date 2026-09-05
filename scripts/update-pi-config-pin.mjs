#!/usr/bin/env node
/**
 * update-pi-config-pin.mjs — focused hourly bump for the silverknight
 * pi-extension pack pin.
 *
 * The weekly `update:managed-tools` sweep is too slow for the pi-config tag
 * cadence (multiple tags per dev day), and its historical releases/latest call
 * 404'd on repos that publish plain git tags. This script resolves the newest
 * `v*` tag of every github-sourced tool in pi_extensions (sourceType
 * "github") AND paseo_plugins (sourceType "paseo-git") families and
 * bumps the manifest pin when a newer tag exists. peter-evans/create-pull-
 * request turns the change into an automated PR; auto-merge-pr.yml merges it
 * as trusted bot work. Exit 0 always unless the manifest write fails.
 */
import { readFile, writeFile } from "node:fs/promises";

const manifestPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "managed-tools/manifest.json";

const githubUserAgent = "openchamber-managed-tools-updater";

function requestHeaders(url) {
  const headers = { "User-Agent": githubUserAgent };
  const hostname = new URL(url).hostname;
  if ((hostname === "api.github.com" || hostname === "github.com") && (process.env.GITHUB_TOKEN || process.env.GH_TOKEN)) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN}`;
  }
  if (hostname === "api.github.com") headers.Accept = "application/vnd.github+json";
  return headers;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: requestHeaders(url) });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.json();
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
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      continue;
    }
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function pickLatestSemverTag(tags) {
  const names = (tags ?? []).map((tag) => tag?.name).filter((name) => /^v?\d+(\.\d+){1,3}(-[\w.]+)?$/.test(String(name)));
  if (names.length === 0) return null;
  return names.sort((a, b) => compareVersions(a, b)).at(-1);
}

async function latestTag(repo) {
  // pi-config publishes annotated git tags (no GitHub Releases).
  const tags = await fetchJson(`https://api.github.com/repos/${repo}/tags?per_page=100`);
  return pickLatestSemverTag(tags);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const tools = [
  ...(manifest.families?.pi_extensions?.tools ?? []),
  ...(manifest.families?.paseo_plugins?.tools ?? []),
];
let changed = false;

for (const tool of tools) {
  if (tool.sourceType !== "github" && tool.sourceType !== "paseo-git") continue;
  const tagName = await latestTag(tool.repo);
  if (!tagName) {
    console.log(`[skip] ${tool.repo} has no v* semver tags`);
    continue;
  }
  if (compareVersions(tagName, tool.version) <= 0) {
    console.log(`[ok] ${tool.name} pin ${tool.version} matches/follows latest tag ${tagName}`);
    continue;
  }
  console.log(`[update] ${tool.name} ${tool.version} -> ${tagName}`);
  tool.version = tagName;
  changed = true;
}

if (!changed) {
  console.log("pi-extension pack pins already up to date");
} else {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("pi-extension pack pins updated");
}
