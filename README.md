# Userscripts

## Azure DevOps Toolbox — `azureDevops/azureDevops.user.js`

One script for the whole team. Install it once in Tampermonkey/Violentmonkey and
it auto-updates from this repo. It bundles five features, each isolated so a
failure in one can't break the others:

1. **PR File Path Tools** — copy buttons + full-path tooltips on PR file headers,
   with line numbers for comment-anchored paths and configurable strip-prefixes.
2. **Branch Name from Work Item** — copy a ready-to-use branch name
   (e.g. `bug/14826-some-title`) from board cards and work items.
3. **PR Hotkeys** — keyboard shortcuts for the comment views and copying the
   source branch (Windows + macOS bindings).
4. **PR Dashboard Filters** — hide drafts, auto-complete PRs, and PRs with
   conflicts from My pull requests.
5. **Open PR in VS Code** — button beside the source branch (or Alt+click the
   branch name) that opens the PR in the AzDO Pull Requests (Multi-Project) VS
   Code extension.
6. **Work Item Hotkeys** — `Ctrl`/`Cmd` + `Enter` saves the discussion comment
   you're editing, matching the PR comment editor.

![Copy button on a PR file header](azureDevops/docs/file-path-copy.png)

**→ See [`azureDevops/README.md`](azureDevops/README.md) for install steps,
screenshots, the full hotkey table, and upgrade notes.**
