#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
if (["--help", "-h", "help"].includes(process.argv[2])) {
  console.log("usage: managed-tools-status.mjs [status|report|compare]");
  process.exit(0);
}
const command = process.argv[2] === "report" ? "status" : (process.argv[2] ?? "status");

if (!["status", "compare"].includes(command)) {
  console.error("usage: managed-tools-status.mjs [status|report|compare]");
  process.exit(2);
}

const familyScripts = [
  "managed-npm-tools.mjs",
  "managed-go-tools.mjs",
  "managed-mounted-tools.mjs",
];

function runFamily(scriptName) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scriptDir, scriptName), command], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

let exitCode = 0;
for (const scriptName of familyScripts) {
  const code = await runFamily(scriptName);
  if (code !== 0 && exitCode === 0) exitCode = code;
}

process.exitCode = exitCode;
