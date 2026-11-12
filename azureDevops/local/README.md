# Local side of the ADO Toolbox (macOS)

Optional. These run on your Mac and power the Toolbox features that need it:
local Claude sessions on a PR, the review clock's idle detection and log, and
`/pr/<id>` links.

| File | What it is |
| --- | --- |
| `ado-companion.mjs` | Local service on `127.0.0.1:47811` (Node, no dependencies) |
| `ccpr.lua` | Hammerspoon module: opens Claude sessions in your `claude agents` view and types requests into them |
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
   settings are at the top of `ccpr.lua`.
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
| `GET /idle` | Seconds since the last keyboard or mouse input |
| `GET`/`POST /review-sessions` | The review clock's log |
