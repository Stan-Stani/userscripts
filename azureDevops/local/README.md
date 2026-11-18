# Local side of the ADO Toolbox (macOS)

Optional. These run on your Mac and power the Toolbox features that need it:
local Claude sessions on a PR, the review clock's idle detection and log, the
focus timer, and `/pr/<id>` links.

| File | What it is |
| --- | --- |
| `ado-companion.mjs` | Local service on `127.0.0.1:47811` (Node, no dependencies) |
| `ccpr.lua` | Hammerspoon module: opens Claude sessions in your `claude agents` view and types requests into them |
| `focus.lua` | Hammerspoon module: the focus timer in the menu bar |
| `focus.mjs` | The focus timer's rules, used by `ado-companion.mjs` (tests: `node --test focus.test.mjs`) |
| `pr-review-sync` | Copies logged review time into a Judgment Log artifact (Stan's; optional) |
| `install.sh` | Links the above into place and starts them with launchd |

## Install

```sh
azureDevops/local/install.sh            # add --with-review-sync for the review-time sync
```

Then:

1. Fill in `~/.config/ado-companion/config.json`:
   - `org`, `project`: where `/pr/<id>` looks PRs up
   - `fallbackRepo`: the repo to open when a PR can't be found
   - `patEnvFile`: a file with an `AZDO_PAT=…` line (otherwise `AZDO_PAT` or `az login`)
   - `judgmentLogUrl`, `claudeConfigDir`: only for `pr-review-sync`
2. Add `require("ccpr").setup{}` to `~/.hammerspoon/init.lua` and reload. Its
   settings are at the top of `ccpr.lua`. For the focus timer, add
   `require("focus").setup()` too.
3. Restart the service after changing settings or pulling:
   `launchctl kickstart -k gui/$(id -u)/com.ado-companion`

Needs `node`, `rg`, `jq` and Claude Code. The scripts are symlinked, so a `git
pull` updates them; restart the service to pick it up.

## Routes

Loopback only. Every POST needs JSON and `X-ADO-Toolbox: 1`, which a web page
can't send here without a CORS preflight the service never answers, so only the
userscript can write.

| Route | Does |
| --- | --- |
| `GET /pr/<id>` | Redirects to the PR's page |
| `GET /claude-sessions?ids=session_…` | Local names of claude.ai sessions |
| `GET /pr-sessions?pr=<id>&branch=<name>` | The PR's local Claude Code sessions |
| `POST /pr-sessions/send` | Opens a session, typing a request into it |
| `POST /pr-sessions/start` | Starts a new session on a PR with a request |
| `GET /idle` | Seconds since the last keyboard or mouse input |
| `GET`/`POST /review-sessions` | The review clock's log |
| `GET`/`POST /focus` | The focus timer: its state and today's totals, and its actions |

## Focus timer

Pomodoro-style: 25 min focus blocks, a 5 min break after each and 15 min after
every 4th (all changeable in the menu's Settings). `focus.lua` shows it in the
menu bar and notifies you when a block or a break runs out.

- **Bank:** skip a break and its minutes are banked; end a break early and the
  whole minutes left go back. When a break is due you can make it longer from
  the bank. The bank has no limit and never empties.
- **Away:** 5 minutes with no keyboard or mouse pauses a focus block from when
  you left; it carries on when you're back.
- **Review clock:** a block ending pauses the PR review clock, and the next focus
  block resumes it. The review clock reports the PR it's timing, so each logged
  block lists the PRs reviewed in it.

State is `~/.local/share/focus/state.json`. Finished blocks, breaks and bank
changes go to `~/.local/share/focus/events.jsonl`, one JSON event per line.
