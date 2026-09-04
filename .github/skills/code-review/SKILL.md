---
name: code-review
description: Repository-specific review guidelines for agent-code-server-docker. Apply to every pull request touching managed-tools scripts, GitHub workflows, Dockerfile.dockerfile, the entrypoint, or version pins.
---

# Code review guidelines

## Language

All code, comments, commit messages, and documentation in this repository
must be in English. Flag any non-English text introduced by a diff.

## Drift class: hardcoded lists that mirror pinned versions

This repository has been bitten twice by hardcoded skill lists drifting from
the pinned tag (`paseo-loop` era vs `paseo-help`/`paseo-plugin` in v0.6.1):
the installer script and the CI check each kept their own copy. Both now
derive the expected set from the canonical skills dir. Flag any new hardcoded
enumeration that duplicates something a pin, tag, or generated directory
already defines — derive from the source of truth instead.

## Version pins must move together

When a diff bumps a version, every mirror of it must be updated in the same
change:

- `Dockerfile.dockerfile` install lines
- `managed-tools/baked-tools.json`: both `currentVersion` and `sourceDetail`
- `managed-tools/manifest.json` pins (the skills pack follows the daemon
  version)

## Tier rules (never cross them)

- `/opt/**` is baked Tier 1 (daemon + core services). Upgrades happen ONLY
  via a Dockerfile bump + image rebuild. Flag any runtime write into `/opt`.
- `~/.npm-global`, `~/.local`, `~/.agents` are Tier 2 managed volume state.
- The entrypoint must invoke baked services by explicit absolute path (e.g.
  `/opt/paseo/bin/paseo`) so `PATH` can never shadow them with a volume
  install. Flag bare-command launches of Tier 1 services.

## Shell pitfalls in workflows

- `count=$(cmd | grep -c pat || echo 0)` is a bug: `grep -c` already prints
  `0` on no match, so the fallback appends a second `0`. Use `|| true`.
- Quote variables used in `[` comparisons.

## Destructive cleanup must be provably safe

Any sweep that deletes symlinks or files must be constrained to a provably
broken state — e.g. delete a symlink only when `lstat` says it is a symlink
AND its target no longer exists — never merely "absent from an expected
list", which can remove valid user-managed entries.
## Runtime ownership
- `bun` is Tier 2 (managed, `release_binaries` in managed-tools/manifest.json). The image ships no bun; do not add it back to the Dockerfile or baked-tools.json. omp depends on it and works from the managed copy in ~/.local/bin.
