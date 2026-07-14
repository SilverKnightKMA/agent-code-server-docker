#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const manifestPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "managed-tools/manifest.json";
const dryRun = process.argv.includes("--dry-run");

const githubUserAgent = "openchamber-managed-tools-updater";
const hashOrder = [
  "CRC32",
  "MD4",
  "MD5",
  "SHA1",
  "TIGER",
  "TTH",
  "BTIH",
  "ED2K",
  "AICH",
  "WHIRLPOOL",
  "RIPEMD-160",
  "GOST94",
  "GOST94-CRYPTOPRO",
  "HAS-160",
  "GOST12-256",
  "GOST12-512",
  "SHA-224",
  "SHA-256",
  "SHA-384",
  "SHA-512",
  "EDON-R256",
  "EDON-R512",
  "SHA3-224",
  "SHA3-256",
  "SHA3-384",
  "SHA3-512",
  "CRC32C",
  "SNEFRU-128",
  "SNEFRU-256",
  "BLAKE2S",
  "BLAKE2B",
];
const yqSha256Index = hashOrder.indexOf("SHA-256") + 1;

function requestHeaders(url) {
  const headers = { "User-Agent": githubUserAgent };
  const hostname = new URL(url).hostname;
  if ((hostname === "api.github.com" || hostname === "github.com") && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  if ((hostname === "api.github.com" || hostname === "github.com") && process.env.GH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  if (hostname === "api.github.com") headers.Accept = "application/vnd.github+json";
  return headers;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: requestHeaders(url) });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function stripPrefix(version) {
  return String(version).replace(/^v/, "").replace(/^go/, "");
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

function familySetting(family, tool, key) {
  return tool[key] ?? family[key];
}

function templateValue(tool, key) {
  if (key === "version") return tool.version;
  if (key === "assetVersion") return tool.assetVersion ?? tool.version;
  if (key === "checksumVersion") return tool.checksumVersion ?? tool.assetVersion ?? tool.version;
  if (key === "releaseVersion") return tool.releaseVersion ?? tool.version;
  return tool[key];
}

function expandTemplate(template, tool) {
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key) => {
    const value = templateValue(tool, key);
    if (value === undefined || value === null) throw new Error(`${tool.name} missing template value ${key}`);
    return value;
  });
}

function assetName(family, tool) {
  const pattern = familySetting(family, tool, "assetPattern");
  if (!pattern) throw new Error(`${tool.name} assetPattern missing`);
  return expandTemplate(pattern, tool);
}

function checksumName(family, tool) {
  const pattern = familySetting(family, tool, "checksumAsset");
  return pattern ? expandTemplate(pattern, tool) : null;
}

function checksumUrl(family, tool) {
  const pattern = familySetting(family, tool, "checksumUrl") ?? familySetting(family, tool, "checksumUrlPattern");
  return pattern ? expandTemplate(pattern, tool) : null;
}

function checksumFormat(family, tool) {
  return familySetting(family, tool, "checksumFormat") ?? "sha256sum";
}

function githubRepo(family, tool) {
  const repo = familySetting(family, tool, "repo");
  if (!repo) throw new Error(`${tool.name} repo missing`);
  return repo;
}

function regexFromTemplate(template) {
  const keys = [];
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(/\\\{([A-Za-z][A-Za-z0-9_]*)\\\}/g, (_match, key) => {
    keys.push(key);
    return "(.+?)";
  });
  return { regex: new RegExp(`^${escaped}$`), keys };
}

function versionFromReleaseTag(family, tool, tagName) {
  const tagPattern = familySetting(family, tool, "tagPattern");
  if (!tagPattern) return stripPrefix(tagName);
  const { regex, keys } = regexFromTemplate(tagPattern);
  const match = tagName.match(regex);
  if (!match) return stripPrefix(tagName);
  const values = Object.fromEntries(keys.map((key, index) => [key, match[index + 1]]));
  return values.version ?? values.assetVersion ?? stripPrefix(tagName);
}

async function latestGithubRelease(family, tool) {
  const repo = githubRepo(family, tool);
  return fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
}

function sha256FromJsonl(text, selectedAssetName) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.dsseEnvelope?.payload ?? entry.payload;
    if (!payload) continue;
    let statement;
    try {
      statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      continue;
    }
    for (const subject of statement.subject ?? []) {
      const digest = subject.name === selectedAssetName ? subject.digest?.sha256 : null;
      if (typeof digest === "string" && digest.match(/^[a-f0-9]{64}$/i)) return digest.toLowerCase();
    }
    for (const dependency of statement.predicate?.buildDefinition?.resolvedDependencies ?? []) {
      const uri = dependency.uri ?? "";
      const digest = uri.endsWith(`/${selectedAssetName}`) ? dependency.digest?.sha256 : null;
      if (typeof digest === "string" && digest.match(/^[a-f0-9]{64}$/i)) return digest.toLowerCase();
    }
  }
  return null;
}

function sha256FromChecksumText(family, tool, text, selectedAssetName) {
  if (checksumFormat(family, tool) === "jsonl-sha256") return sha256FromJsonl(text, selectedAssetName);
  if (tool.name === "yq") {
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${selectedAssetName} `));
    const parts = line?.trim().split(/\s+/) ?? [];
    return parts[yqSha256Index]?.toLowerCase() ?? null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(selectedAssetName)) continue;
    const match = line.match(/([a-f0-9]{64})/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

async function verifyReleaseTool(family, tool, release) {
  const selectedAssetName = assetName(family, tool);
  const asset = release.assets?.find((entry) => entry.name === selectedAssetName);
  if (!asset) throw new Error(`${tool.name} release ${release.tag_name} missing asset ${selectedAssetName}`);
  if (familySetting(family, tool, "checksumPolicy") === "allowGithubDigest") {
    const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
    if (!digest) throw new Error(`${tool.name} release ${release.tag_name} asset ${selectedAssetName} missing GitHub SHA-256 digest`);
    return;
  }
  const checksumAsset = checksumName(family, tool);
  const checksumDownloadUrl = checksumUrl(family, tool);
  if (!checksumAsset && !checksumDownloadUrl) throw new Error(`${tool.name} checksum source missing`);
  const checksumEntry = checksumAsset ? release.assets?.find((entry) => entry.name === checksumAsset) : null;
  if (checksumAsset && !checksumEntry) throw new Error(`${tool.name} release ${release.tag_name} missing checksum asset ${checksumAsset}`);
  const checksumSource = checksumEntry?.browser_download_url ?? checksumDownloadUrl;
  const checksumText = await fetchText(checksumSource);
  const digest = sha256FromChecksumText(family, tool, checksumText, selectedAssetName);
  if (!digest) throw new Error(`${tool.name} checksum for ${selectedAssetName} not found in ${checksumAsset ?? checksumSource}`);
}

function storedVersion(tool, nextVersion) {
  if (String(tool.version).startsWith("v") && String(nextVersion).startsWith("v")) return String(nextVersion);
  return stripPrefix(nextVersion);
}

function setVersion(tool, nextVersion, options = {}) {
  const { log = true } = options;
  const normalized = storedVersion(tool, nextVersion);
  if (compareVersions(normalized, tool.version) <= 0) return false;
  if (log) console.log(`[update] ${tool.name} ${tool.version} -> ${normalized}`);
  tool.version = normalized;
  return true;
}

async function updateNpmFamily(manifest) {
  let changed = false;
  for (const tool of manifest.families.npm?.tools ?? []) {
    const registry = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(tool.pkg)}`);
    const latest = registry["dist-tags"]?.latest;
    if (!latest) throw new Error(`${tool.name} npm package ${tool.pkg} missing latest dist-tag`);
    changed = setVersion(tool, latest) || changed;
  }
  return changed;
}

async function updateGoToolchain(manifest) {
  const family = manifest.families.go_toolchain;
  const tool = family?.tools?.[0];
  if (!tool) return false;
  const releases = await fetchJson(family.checksumUrlPattern);
  for (const release of releases) {
    const version = stripPrefix(release.version);
    const archiveName = tool.assetPattern.replace("{version}", version);
    const file = release.files?.find((entry) => entry.filename === archiveName && entry.os === tool.os && entry.arch === tool.arch);
    if (!file) continue;
    if (!file.sha256) throw new Error(`${archiveName} missing sha256 in Go metadata`);
    return setVersion(tool, version);
  }
  throw new Error(`no matching Go ${tool.os}/${tool.arch} release found`);
}

function goModulePath(pkg) {
  const cmdIndex = pkg.indexOf("/cmd/");
  return cmdIndex === -1 ? pkg : pkg.slice(0, cmdIndex);
}

async function updateGoTools(manifest) {
  let changed = false;
  for (const tool of manifest.families.go_tools?.tools ?? []) {
    const latest = await fetchJson(`https://proxy.golang.org/${goModulePath(tool.pkg)}/@latest`);
    if (!latest.Version) throw new Error(`${tool.name} Go module ${tool.pkg} missing latest version`);
    changed = setVersion(tool, latest.Version) || changed;
  }
  return changed;
}

function cmakeSupportDirectory(version) {
  const majorMinor = version.match(/^(\d+\.\d+)/)?.[1];
  if (!majorMinor) throw new Error(`unable to derive CMake support directory from ${version}`);
  return `cmake-${majorMinor}`;
}

function updateCmakeSupportPaths(tool, options = {}) {
  const { log = true } = options;
  const supportDir = cmakeSupportDirectory(tool.version);
  const source = `cmake-{version}-linux-x86_64/share/${supportDir}`;
  const target = `~/.local/managed/cmake/{version}/share/${supportDir}`;
  if (!Array.isArray(tool.supportPaths) || tool.supportPaths.length === 0) tool.supportPaths = [{}];
  const entry = tool.supportPaths[0];
  const changed = entry.source !== source || entry.target !== target;
  entry.source = source;
  entry.target = target;
  if (changed && log) console.log(`[update] cmake support path -> ${supportDir}`);
  return changed;
}

function protobufVersionFromAssetVersion(assetVersion) {
  return assetVersion.split(".").length === 2 ? `${assetVersion}.0` : assetVersion;
}

function updateProtobufVersionFields(tool, assetVersion, options = {}) {
  const { log = true } = options;
  const version = protobufVersionFromAssetVersion(assetVersion);
  const changed = compareVersions(version, tool.version) > 0;
  if (!changed) return false;
  if (log) console.log(`[update] ${tool.name} ${tool.version} -> ${version}`);
  tool.version = version;
  tool.assetVersion = assetVersion;
  tool.checksumVersion = `4.${assetVersion}`;
  return true;
}

async function updateReleaseFamilies(manifest) {
  let changed = false;
  const releaseFamilyNames = ["gh", "release_binaries", "llvm_tools", "cmake", "protobuf"];
  for (const familyName of releaseFamilyNames) {
    const family = manifest.families[familyName];
    if (!family) continue;
    for (const tool of family.tools ?? []) {
      const release = await latestGithubRelease(family, tool);
      if (tool.name === "protobuf-compiler") {
        const assetVersion = versionFromReleaseTag(family, tool, release.tag_name);
        const candidate = structuredClone(tool);
        const candidateChanged = updateProtobufVersionFields(candidate, assetVersion, { log: false });
        if (candidateChanged) {
          try {
            await verifyReleaseTool(family, candidate, release);
          } catch (error) {
            console.warn(`[skip] ${tool.name} ${assetVersion} not verified: ${error.message}`);
            continue;
          }
          changed = updateProtobufVersionFields(tool, assetVersion) || changed;
        }
        continue;
      }
      const nextVersion = versionFromReleaseTag(family, tool, release.tag_name);
      const candidate = structuredClone(tool);
      const candidateChanged = setVersion(candidate, nextVersion, { log: false });
      const candidateSupportChanged = tool.name === "cmake" ? updateCmakeSupportPaths(candidate, { log: false }) : false;
      if (candidateChanged || candidateSupportChanged) {
        try {
          await verifyReleaseTool(family, candidate, release);
        } catch (error) {
          console.warn(`[skip] ${tool.name} ${nextVersion} not verified: ${error.message}`);
          continue;
        }
      }
      if (candidateChanged) {
        setVersion(tool, nextVersion);
        changed = true;
      }
      if (tool.name === "cmake") changed = updateCmakeSupportPaths(tool) || changed;
    }
  }
  return changed;
}

async function updateRustup(manifest) {
  const family = manifest.families.rustup;
  const text = await fetchText("https://static.rust-lang.org/dist/channel-rust-stable.toml");
  const version = text.match(/\[pkg\.rust\][\s\S]*?version\s*=\s*"([^\s"]+)/)?.[1];
  if (!version) throw new Error("unable to parse stable Rust version");
  let changed = false;
  for (const tool of family.tools ?? []) changed = setVersion(tool, version) || changed;
  return changed;
}

async function updatePaseoSkills(manifest) {
  const family = manifest.families?.paseo_skills;
  const tool = family?.tools?.[0];
  if (!tool?.repo) return false;
  const release = await fetchJson(`https://api.github.com/repos/${tool.repo}/releases/latest`, requestHeaders(`https://api.github.com/repos/${tool.repo}/releases/latest`));
  const tagName = release.tag_name;
  if (!tagName || tagName === tool.version) return false;
  setVersion(tool, tagName, { stripV: false });
  return true;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
let changed = false;

changed = await updateNpmFamily(manifest) || changed;
changed = await updatePaseoSkills(manifest) || changed;
changed = await updateGoToolchain(manifest) || changed;
changed = await updateGoTools(manifest) || changed;
changed = await updateReleaseFamilies(manifest) || changed;
changed = await updateRustup(manifest) || changed;

if (!changed) {
  console.log("managed-tools manifest already up to date");
} else if (dryRun) {
  console.log("managed-tools manifest would be updated");
} else {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("managed-tools manifest updated");
}
