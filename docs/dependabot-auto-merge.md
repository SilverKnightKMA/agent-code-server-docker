# Dependabot Auto-Merge

## Overview

Dependabot automatically opens pull requests when newer versions of
dependencies are available. This repo uses:

1. **Dependabot groups** to reduce PR count by combining patch and minor
   updates per ecosystem into a single PR.
2. **Native GitHub auto-merge** to merge safe Dependabot PRs automatically
   once required checks pass.
3. **Manual review** for major version updates.

## Dependabot groups

Dependabot is configured in `.github/dependabot.yml` with three groups,
one per ecosystem:

| Ecosystem | Group name | Updates grouped |
|-----------|-----------|----------------|
| docker | `docker-minor-patch` | Patch and minor version bumps |
| npm | `npm-minor-patch` | Patch and minor version bumps |
| github-actions | `github-actions-minor-patch` | Patch and minor version bumps |

**Major updates are not grouped** — each major version bump creates a
separate PR that requires manual review.

Groups reduce the number of simultaneous Dependabot PRs. Without groups,
Dependabot opens one PR per dependency per version bump. With groups,
all compatible patch and minor updates within an ecosystem are batched.

## Auto-merge policy

The workflow `.github/workflows/dependabot-auto-merge.yml` runs on
`pull_request_target` and inspects Dependabot metadata to decide whether
to enable auto-merge.

| Update type | Auto-merge? | Reason |
|-------------|------------|--------|
| `semver-patch` | Yes | Safe, backwards-compatible bug fixes |
| `semver-minor` | Yes | Safe, backwards-compatible features |
| `semver-major` | No | Requires manual review |
| Unknown | No | Cannot determine safety |

### Security

The auto-merge workflow:

- Only triggers for `github.actor == 'dependabot[bot]'`
- Does **not** checkout or execute PR branch code
- Does **not** run `npm install`, tests, or any untrusted scripts
- Uses `dependabot/fetch-metadata` to inspect PR metadata
- Never bypasses branch protection — auto-merge only enables after all
  required checks pass

## Required repository settings

### Branch protection rules

For auto-merge to work safely, the `main` branch should have protection
rules that require:

1. **managed-tools-check** — validates all managed tools install from
   upstream config
2. **Build Image** — verifies the Docker image builds successfully
3. **Other CI checks** — any additional status checks configured in the
   repo

### Enable auto-merge on the repo

Auto-merge must be enabled at the repository level:
`Settings > General > Pull Requests > Allow auto-merge`.

### Merge queue (recommended for busy repos)

If Dependabot opens multiple simultaneous PRs (even with groups), the
first one to merge can cause the others to be out of date. GitHub's
**Merge Queue** handles this automatically:

`Settings > Branches > Branch protection rule for main > Require merge queue`

With a merge queue:
- PRs that are out of date against the target branch are rebased and
  retested automatically.
- The queue processes PRs in order, preventing merge conflicts.
- Dependabot PRs are merged sequentially, each with a fresh CI run.

Without a merge queue, PRs behind the target branch stay behind until
rebased. This is safe — they are never force-merged — but may require
manual rebase or the "Update branch" button.

## What is NOT covered by Dependabot

The `managed-tools/manifest.json` and `managed-tools/policy.json`
files contain custom release tool version pins (gh, yq, ripgrep,
actionlint, hadolint, go, rustc, cargo, npm packages). These are **not**
managed by Dependabot because they are not standard package manifests.

Updates to managed-tools config are validated by the
`managed-tools-check` workflow, which runs against the upstream online
config and verifies all tools reach `state=equal` after init.

If a managed-tools PR happens to touch `manifest.json` or `policy.json`,
the auto-merge workflow will skip it — these files require explicit
manual review.
