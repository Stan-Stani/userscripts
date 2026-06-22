# Azure DevOps Toolbox

A single userscript for the whole team that adds quality-of-life helpers to
Azure DevOps pull requests and work items. Install once; it auto-updates from
this repo.

It bundles three features, each isolated so a failure in one can't break the
others.

> The screenshots below use placeholder data — paths, work items, and branch
> names are fictional.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/)
   or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw script to trigger an install prompt:
   [`azureDevops.user.js`](https://raw.githubusercontent.com/Stan-Stani/userscripts/main/azureDevops/azureDevops.user.js)
3. Confirm the install. New versions roll out automatically via the script's
   `@updateURL` — no need to reinstall.

Works on `dev.azure.com` and legacy `*.visualstudio.com` hosts.

---

## 1. PR File Path Tools

Adds copy-to-clipboard buttons and full-path tooltips to file headers — on both
the **Overview** comment threads and the **Files** tab.

![Copy button on a PR file header](docs/file-path-copy.png)

- **Click** the copy button — copies the path, with any configured prefix stripped.
- **Shift + click** — copies the full, untrimmed path.
- For a comment anchored to a specific line, the copied path includes the line
  number in editor/grep style: `…/useCheckout.ts:142`.

### Strip prefixes (right-click)

**Right-click** a copy button to manage "strip prefixes" — repo-relative
prefixes to drop so you copy just the part you care about. `*` matches any
single path segment. Prefixes are stored per-origin in `localStorage`, and a
live preview shows the result of each rule.

![Strip-prefix manager popover](docs/strip-prefix-popover.png)

---

## 2. Branch Name from Work Item

Adds a copy button to sprint board cards and work item pages that copies a
ready-to-use branch name.

![Copy a work item as a branch name](docs/branch-name-copy.png)

The branch name is `<prefix>/<id>-<kebab-title>`, where the prefix comes from the
work item type:

| Work item type | Prefix  |
| -------------- | ------- |
| Bug            | `bug`   |
| Change Request | `cr`    |
| User Story     | `us`    |
| Feature        | `feat`  |
| Task           | `task`  |

---

## 3. PR Hotkeys

| Action                                     | Windows         | macOS                  |
| ------------------------------------------ | --------------- | ---------------------- |
| Show only active (unresolved) comments     | `Ctrl` + `→`    | `Ctrl` + `Opt` + `→`   |
| Show all comments                          | `Ctrl` + `←`    | `Ctrl` + `Opt` + `←`   |
| Copy source branch name to clipboard       | `Win` + `]`     | `Cmd` + `Opt` + `]`    |

The macOS bindings differ on purpose: plain `Ctrl` + arrow is reserved by
Mission Control (switch spaces), and plain `Cmd` + `]` is the browser's Forward
navigation — so the Mac shortcuts add `Opt` to avoid both.

---

> **Upgrading from the old scripts?** This replaces the three separate scripts
> (`azureDevopsPRs-filePath`, `azureDevopsPRs-hotkeys`,
> `azureDevops-branchNameFromWI`). Uninstall those from your userscript manager
> first to avoid duplicate buttons.
