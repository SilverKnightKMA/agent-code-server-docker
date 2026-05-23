# Branch Protection Configuration

## Overview

The `main` branch is protected. This document explains how branch protection
interacts with path-filtered workflows and auto-merge gating.

## Branch Protection Settings (GitHub UI)

Recommended settings in **Settings > Branches > main**:

| Setting | Value |
|---------|-------|
| Require pull request before merging | Enabled |
| Require conversation resolution | Enabled |
| Dismiss stale reviews | Recommended |
| Do not allow bypassing | Enabled |
| Do not allow force pushes | Enabled |
| Do not allow deletions | Enabled |
| Allow auto-merge | Enabled |
| Require status checks before merging | Enabled (see below) |

## Path-Filtered Checks Must Not Be Globally Required

Three validation workflows use `paths:` filters to trigger only when relevant
files change:

| Workflow | Triggers On |
|----------|-------------|
| `baked-tools-check.yml` | Dockerfile\*, scripts/\*\*, bootstrap.sh, package.json, package-lock.json, bun.lock, go.mod, go.sum, tools.go, baked-tools.json, both workflow files |
| `baked-tools-monitor.yml` | baked-tools.json, Dockerfile\*, scripts/\*\* |
| `managed-tools-check.yml` | package.json, package-lock.json, go.mod, go.sum, tools.go, scripts/managed-*.mjs, managed-tools/manifest.json, managed-tools/policy.json, workflow file |

**These workflows must NOT be listed as globally required checks in branch
protection settings.** GitHub Actions behavior:

- When a PR does not match a workflow's `paths:` filter, the workflow is
  **skipped entirely** — no check run is created, no success/failure status
  is posted.
- If a skipped workflow is listed as a globally required check in branch
  protection, GitHub sees it as "no status" and blocks the merge forever.
- There is no way to mark a workflow as "intentionally skipped" in GitHub's
  branch protection system.

Therefore, only checks that run on **every PR** (e.g., gitleaks) should be
globally required. Path-specific validation is enforced by the auto-merge
gating system, not by GitHub's native required-checks mechanism.

## How Auto-Merge Gating Enforces Path-Specific Checks

Both `auto-merge-pr.yml` and `dependabot-auto-merge.yml` implement path-aware
validation before enabling native auto-merge. The steps are:

1. **Classify changed files**: query `gh pr view --json files` to list all
   changed paths, then classify into path groups:
   - **Baked-tools paths**: `Dockerfile*`, `scripts/**`, `bootstrap.sh`,
     `package.json`, `package-lock.json`, `bun.lock`, `go.mod`, `go.sum`,
     `tools.go`, `managed-tools/baked-tools.json`,
     `.github/workflows/baked-tools-check.yml`,
     `.github/workflows/baked-tools-monitor.yml`
   - **Managed-tools paths**: `package.json`, `package-lock.json`, `go.mod`,
     `go.sum`, `tools.go`, `scripts/managed-npm-tools.mjs`,
     `scripts/managed-go-tools.mjs`, `scripts/managed-mounted-tools.mjs`,
     `scripts/managed-tools-config.mjs`, `scripts/managed-tools-output.mjs`,
     `scripts/managed-tools-status.mjs`, `scripts/validate-managed-tools.mjs`,
     `managed-tools/manifest.json`, `managed-tools/policy.json`,
     `.github/workflows/managed-tools-check.yml`

2. **Query check runs**: fetch all check runs for the PR head commit via
   `repos/{owner}/{repo}/commits/{sha}/check-runs`. Match by check name.

3. **Verify success**: each applicable check must have `conclusion == "SUCCESS"`.
   - Missing checks → block (workflow was skipped or didn't run)
   - Pending/failed/cancelled → block
   - All SUCCESS → enable auto-merge

4. **Enable auto-merge**: only if all gates pass, run
   `gh pr merge --auto --squash`.

## Example: Doc-Only PR

A PR that only changes `docs/*.md`:
- Does **not** match baked-tools paths — no baked-tools check runs
- Does **not** match managed-tools paths — no managed-tools check runs
- Auto-merge gating sees empty required-checks list → `checks_ok=true`
- No branch protection bypass needed

## Example: Dockerfile PR

A PR that changes `Dockerfile.dockerfile`:
- Matches baked-tools paths
- Auto-merge gating checks for `Validate baked tools in image` and
  `Monitor baked tool versions`
- Both must be SUCCESS before auto-merge is enabled
- No managed-tools changes → managed-tools check not required

## Example: manifest.json PR

A PR that changes `managed-tools/manifest.json`:
- Matches managed-tools paths
- Auto-merge gating checks for `Install & verify managed tools`
- Must be SUCCESS before auto-merge is enabled

## Globally Required Checks

The only checks that run on every PR and should be globally required:

| Check | Purpose |
|-------|---------|
| `gitleaks` | Secret scanning |
| CodeQL analysis | Code quality and security |

These run regardless of changed files and will always produce a conclusion
on every PR.

## Branch Protection Rules Summary

```
Do globally require:        gitleaks, CodeQL*
Do NOT globally require:    baked-tools-check, baked-tools-monitor,
                            managed-tools-check
Auto-merge gates enforce:   path-specific check requirements
```

\*CodeQL is configured as a built-in GitHub Advanced Security check and is
not part of this repository's workflow definitions.
