# Userscripts

## Azure DevOps Toolbox — `azureDevops/azureDevops.user.js`

One script for the whole team. Install it once in Tampermonkey/Violentmonkey and
it auto-updates from this repo. It bundles three features, each isolated so a
failure in one can't break the others:

### 1. PR File Path Tools

On Azure DevOps pull requests, adds copy-to-clipboard buttons and full-path
tooltips to file headers (both the Overview comment threads and the Files tab).

- **Click** the copy button: copies the path (with any configured prefix stripped).
- **Shift+click**: copies the full, untrimmed path.
- **Right-click**: manage "strip prefixes" (supports `*` as a single-segment
  wildcard). Prefixes are stored per-origin in `localStorage`.

### 2. Branch Name from Work Item

Adds a copy button to sprint board cards and work item pages that copies a
ready-to-use branch name, e.g. `bug/14826-some-title`, `cr/14826-some-title`.
Prefix is derived from the work item type (bug → `bug`, change request → `cr`,
user story → `us`, feature → `feat`, task → `task`).

### 3. PR Hotkeys

- `Ctrl + Right Arrow`: Show only active (unresolved) comments
- `Ctrl + Left Arrow`: Show everything
- `Cmd/Win + ]`: Copy source branch name to clipboard

---

> **Upgrading from the old scripts?** This replaces the three separate scripts
> (`azureDevopsPRs-filePath`, `azureDevopsPRs-hotkeys`, `azureDevops-branchNameFromWI`).
> Uninstall those from your userscript manager first to avoid duplicate buttons.
