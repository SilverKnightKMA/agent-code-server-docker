#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const manifestPath = process.argv[2] ?? "managed-tools/manifest.json";
const policyPath = process.argv[3] ?? "managed-tools/policy.json";

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const policy = JSON.parse(await readFile(policyPath, "utf8"));

const requiredFamilies = [
  "npm",
  "paseo_skills",
  "pi_extensions",
  "go_toolchain",
  "go_tools",
  "gh",
  "release_binaries",
  // "llvm_tools",
  // "cmake",
  // "protobuf",
  "rustup",
];

for (const familyName of requiredFamilies) {
  const family = manifest.families?.[familyName];
  if (!family) throw new Error(`managed-tools manifest missing ${familyName} family`);
  if (!Array.isArray(family.tools) || family.tools.length === 0) {
    throw new Error(`${familyName} family must declare at least one tool`);
  }
}

if (!policy.policy?.compare) throw new Error("managed-tools policy missing compare policy");

for (const [familyName, family] of Object.entries(manifest.families ?? {})) {
  if (!family.installMethod) throw new Error(`${familyName} missing installMethod`);
  for (const tool of family.tools ?? []) {
    if (!tool.name) throw new Error(`${familyName} contains a tool without a name`);
    if (!tool.version) throw new Error(`${familyName}/${tool.name} missing version`);
  }
}

for (const tool of manifest.families.go_tools.tools) {
  if (!tool.version.startsWith("v")) {
    throw new Error(`go_tools/${tool.name} version must keep the Go module v-prefix`);
  }
}

for (const familyName of ["gh", "release_binaries"]) {
  const family = manifest.families[familyName];
  if (!family) continue;
  for (const tool of family.tools ?? []) {
    const repo = tool.repo ?? family.repo;
    const assetPattern = tool.assetPattern ?? family.assetPattern;
    const checksumPolicy = tool.checksumPolicy ?? family.checksumPolicy;
    const checksumFormat = tool.checksumFormat ?? family.checksumFormat;
    if (!repo) throw new Error(`${familyName}/${tool.name} missing repo`);
    if (!assetPattern) throw new Error(`${familyName}/${tool.name} missing assetPattern`);
    if (!checksumPolicy) throw new Error(`${familyName}/${tool.name} missing checksumPolicy`);
    if (!checksumFormat) throw new Error(`${familyName}/${tool.name} missing checksumFormat`);
  }
}

for (const tool of manifest.families.paseo_skills.tools) {
  if (!tool.source) throw new Error(`paseo_skills/${tool.name} missing source`);
  if (!tool.repo) throw new Error(`paseo_skills/${tool.name} missing repo`);
}

console.log("managed-tools manifest valid");
