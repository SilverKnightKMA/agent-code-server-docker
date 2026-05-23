# Automation Bot (GitHub App)

## Why GITHUB_TOKEN-created PRs are not enough

By default, GitHub Actions workflows use `GITHUB_TOKEN` for API operations.
PRs created with `GITHUB_TOKEN` have the `github-actions[bot]` as author and
trigger `pull_request` workflows. Under standard branch protection, this
works fine.

However, under strict branch protection that requires all workflow checks to
pass before merge, `GITHUB_TOKEN`-created PRs can encounter issues:

- **Workflow trigger delays**: Some branch protection rules require manual
  approval for first-time contributors. The `github-actions[bot]` actor is the
  same across all repos, so GitHub may not recognize it as a trusted
  automation source.
- **Required check propagation**: PRs from `GITHUB_TOKEN` may not reliably
  trigger all configured required checks.
- **Auto-merge compatibility**: To enable native auto-merge, `gh pr merge
  --auto` must be called. Using `GITHUB_TOKEN` may produce PRs that are not
  auto-mergeable under the same policies.

Using a dedicated GitHub App token avoids these problems:

- The app is installed on the repository and its token is scoped to exactly
  the permissions the app needs.
- PRs created by the app are recognized as a known automation source.
- Required checks run normally.
- Native auto-merge works reliably.

## Creating the GitHub App

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub
   App**.
2. Fill in:
   - **GitHub App name**: `code-server-omp-bot` (or your preferred name)
   - **Homepage URL**: your repository URL
   - **Webhook**: Active (uncheck) — webhooks are not needed
3. Under **Permissions**:
   - Repository permissions:
     - `Contents`: **Read and write**
     - `Pull requests`: **Read and write**
     - `Metadata`: **Read** (auto-selected)
4. Under **Where can this GitHub App be installed?**: select **Any account**
   or **Only this account**.
5. Click **Create GitHub App**.
6. After creation:
   - Note the **App ID** on the app page (e.g., `123456`).
   - Generate a **Private Key** and download the `.pem` file.
   - Install the app on the target repository.

## Required Repository Variables and Secrets

Set these in the repository **Settings > Secrets and variables > Actions**:

| Name | Type | Value |
|------|------|-------|
| `APP_ID` | Secret | The GitHub App ID (integer, e.g. `123456`) |
| `APP_PRIVATE_KEY` | Secret | The full private key PEM content (including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`) |

These are consumed by the `update-managed-tools.yml` workflow:

```yaml
- name: Generate GitHub App token
  id: app-token
  uses: actions/create-github-app-token@v2
  with:
    app-id: ${{ secrets.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

The token is then used for `checkout` and `create-pull-request`:

```yaml
- uses: actions/checkout@v6
  with:
    token: ${{ steps.app-token.outputs.token }}

- uses: peter-evans/create-pull-request@v9
  with:
    token: ${{ steps.app-token.outputs.token }}
```

## Required GitHub App Permissions

| Permission | Level | Reason |
|------------|-------|--------|
| Contents | Read and write | Checkout code, push branches, create commits |
| Pull requests | Read and write | Create PRs, add labels |
| Metadata | Read | Read repository metadata (auto-granted) |

The app does **not** need admin permissions. It creates PRs only; branch
protection + required checks decide whether the PR can merge.

## Verifying PR Author and Checks

After the workflow runs, verify:

1. The PR author is `BOT_NAME[bot]` (the GitHub App's bot account).
2. All required workflow checks ran on the PR:
   - `managed-tools-check`
   - `baked-tools-check`
   - `baked-tools-monitor`
   - `gitleaks`
3. The `automated` label is present on the PR.
4. If auto-merge is configured, `gh pr merge --auto` has been called.

You can check the PR's check status with:

```
gh pr view <PR_NUMBER> --json statusCheckRollup
```

## Auto-merge Policy

The `auto-merge-pr.yml` workflow enables native auto-merge for automation
PRs. It trusts PRs from:
- `dependabot[bot]`
- Any GitHub App bot (author ends with `[bot]`)

Auto-merge is **only** enabled when **all** conditions are met:
- Author is a trusted automation source (Dependabot or GitHub App bot)
- PR has the `automated` label
- PR does **not** have the `wip` label
- PR is not a draft

User-created PRs are never auto-merged, even if they somehow have the
`automated` label (users cannot add labels they don't have permission for).

## Fallback: Fine-Grained PAT

If a GitHub App is not feasible, a fine-grained Personal Access Token (PAT)
from a bot account can be used instead. To use a PAT:

1. Create a bot GitHub account (e.g., `code-server-omp-bot`).
2. Generate a fine-grained PAT with `contents: write` and `pull-requests:
   write` permissions, scoped to this repository.
3. Add the PAT as a repository secret (e.g., `BOT_TOKEN`).
4. In `update-managed-tools.yml`, replace the `create-github-app-token` step
   with:

   ```yaml
   - name: Checkout builder repository
     uses: actions/checkout@v6
     with:
       token: ${{ secrets.BOT_TOKEN }}

   - name: Create pull request
     uses: peter-evans/create-pull-request@v9
     with:
       token: ${{ secrets.BOT_TOKEN }}
   ```

**Why GitHub App is preferred**:
- Fine-grained PATs expire and must be rotated.
- PATs are associated with a user account which may have MFA requirements.
- GitHub App tokens are short-lived (1 hour) and automatically rotated.
- The `actions/create-github-app-token` action handles token generation with
  no secret rotation burden.

## Security Considerations

- The private key stored in `APP_PRIVATE_KEY` is **never logged** by the
  `actions/create-github-app-token` action.
- The generated token is short-lived (1 hour) and scoped to the app's
  permissions.
- The `update-managed-tools.yml` workflow runs on schedule, not on
  `pull_request_target`, so it does not execute untrusted PR code.
- The `auto-merge-pr.yml` workflow uses `pull_request_target` but only reads
  PR metadata (author, labels, draft status) via `gh pr view` — it does not
  checkout or execute PR code.
- The GitHub App has no admin permissions. It cannot bypass branch protection
  or modify repository settings.
- Branch protection remains the authority on what can merge. The bot only
  creates PRs; required checks decide merge eligibility.
