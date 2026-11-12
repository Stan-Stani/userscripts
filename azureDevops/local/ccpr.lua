-- hammerspoon://cc-pr?id=12317&branch=us/19457-x
--
-- Fired by the "Resume locally" button in the Azure DevOps Toolbox userscript
-- (azureDevops/ in the userscripts repo; this file is azureDevops/local/ccpr.lua,
-- loaded from ~/.hammerspoon/init.lua with require("ccpr").setup{…}). Lists the PR's local Claude Code
-- sessions (`cc-pr --list`, ~/.local/bin, linked from that repo) in a chooser (a
-- single match skips it), resumes the pick as a background agent (`cc-pr
-- --no-attach`, which reports its name) and opens it from an agents view started
-- with AGENTS_COMMAND: ctrl+f, its name, Enter. Opened that way, ← goes back to the
-- same view with its flags; `claude attach` would instead leave ← opening a bare
-- `claude agents`, which starts new sessions in auto mode.
--
-- The view is the last-used iTerm window's agents pane, preferring one started with a
-- permission flag, then the active pane. A pane showing a flagless view or an attached
-- session is restarted as AGENTS_COMMAND first (both are only views: no session
-- stops). With no agents pane, a new window runs AGENTS_COMMAND.
--
-- The keys are typed into a terminal, so every step first reads the pane and checks
-- it shows what the next key expects (the strings Claude Code 2.1.314 draws). Any
-- surprise, a name matching no session or several, or text left in an open
-- session's prompt stops it there with an alert; it never types into a prompt.
--
-- Any web page can open a hammerspoon:// URL, so only a digits-only id and a
-- branch-shaped branch reach cc-pr, the transcript path and session name come from
-- cc-pr itself, and the permission mode is set here, never by the URL.
local M = {}

-- Settings, given to setup{…} in init.lua (these are the defaults):
--   dangerouslySkipPermissions = false  DANGEROUS when true: sessions resume with
--       --dangerously-skip-permissions, every permission check bypassed.
--   agentsCommand = "claude agents"     the agents view a new window or a restarted
--       pane runs, e.g. an alias for `claude agents --dangerously-skip-permissions`.
--   newSessionConfigDir = nil           the Claude profile (CLAUDE_CONFIG_DIR) a new
--       session from a comment thread starts in; nil = the default profile.
M.dangerouslySkipPermissions = false
local AGENTS_COMMAND = "claude agents"

local HOME = os.getenv("HOME")
local NEW_SESSION_CONFIG_DIR = nil
local CC_PR = HOME .. "/.local/bin/cc-pr"
-- hs.task has no login-shell PATH; cc-pr needs rg, jq and claude.
local PATH = HOME .. "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
local ME = os.getenv("USER")

local function osa(script)
    local ok, result, err = hs.osascript.applescript(script)
    if not ok then hs.alert.show("cc-pr: iTerm — " .. tostring(err and err.NSAppleScriptErrorMessage or err), 4) end
    return ok, result
end

-- Every iTerm pane, the last-used window's first: { win, uid, tty, current }
local function panes()
    -- Inside the tell block `tab` is iTerm's tab class, not a tab character.
    local ok, out = osa([[
        set sep to character id 9
        tell application "iTerm"
            set out to ""
            set frontId to missing value
            try
                set frontId to id of current window
            end try
            set ordered to {}
            repeat with w in windows
                if id of w is frontId then
                    set beginning of ordered to w
                else
                    set end of ordered to w
                end if
            end repeat
            repeat with w in ordered
                set cur to unique id of current session of w
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        set out to out & (id of w) & sep & (unique id of s) & sep & (tty of s) & sep & ((unique id of s) is cur) & linefeed
                    end repeat
                end repeat
            end repeat
            return out
        end tell
    ]])
    local list = {}
    if not ok then return list end
    for line in (out or ""):gmatch("[^\n]+") do
        local win, uid, tty, cur = line:match("^(%d+)\t([^\t]+)\t([^\t]+)\t(%a+)$")
        if win then table.insert(list, { win = win, uid = uid, tty = tty, current = cur == "true" }) end
    end
    return list
end

-- The pane's foreground `claude agents` (or attached session) of this user: its
-- process group and command line, else nil.
local function agentsView(tty)
    local out = hs.execute("ps -t " .. tty:gsub("^/dev/", "") .. " -o pgid=,tpgid=,user=,command=") or ""
    for line in out:gmatch("[^\n]+") do
        local pgid, tpgid, user, cmd = line:match("^%s*(%d+)%s+(%d+)%s+(%S+)%s+(.*)$")
        -- A view that ← relaunched shows the binary's full path.
        if pgid and pgid == tpgid and user == ME and (cmd:match("^%S*claude agents") or cmd:match("^%S*claude attach")) then
            return pgid, cmd
        end
    end
end

-- Runs `body` (AppleScript, with `s` bound to the pane's session) and returns its
-- result.
local function withSession(p, body)
    return osa(string.format([[
        tell application "iTerm"
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        if unique id of s is "%s" then
                            %s
                        end if
                    end repeat
                end repeat
            end repeat
            return ""
        end tell
    ]], p.uid, body))
end

local function focus(p)
    withSession(p, [[
        activate
        select w
        tell t to select
        tell s to select
        return ""
    ]])
end

-- Types `expr` (an AppleScript text expression) into the pane; with `newline`, as a
-- command line.
local function send(p, expr, newline)
    withSession(p, string.format("tell s to write text %s newline %s\nreturn \"\"", expr, newline and "yes" or "no"))
end

local function quoted(text)
    return '"' .. text:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
end

local KEY = {
    esc = "(ASCII character 27)",
    enter = "(ASCII character 13)",
    find = "(ASCII character 6)", -- ctrl+f
    left = '((ASCII character 27) & "[D")',
    backspace = "(ASCII character 127)",
}

-- What the pane shows now, as its non-blank lines: the last `rows` lines of its
-- contents. The rest is scrollback, which can hold another view's last frame (a
-- session's divider line carries its name, for one).
local function screen(p)
    local ok, text = withSession(p, "return (rows of s as string) & (character id 10) & (contents of s)")
    if not ok or type(text) ~= "string" then return "" end
    local rows, body = text:match("^(%d+)\n(.*)$")
    if not rows then return "" end
    -- Claude Code draws no-break spaces (after the ❯ prompt, for one), which %s misses.
    body = body:gsub("\194\160", " ")
    local all = {}
    for line in (body .. "\n"):gmatch("(.-)\n") do table.insert(all, line) end
    if all[#all] == "" then table.remove(all) end
    local lines = {}
    for i = math.max(1, #all - tonumber(rows) + 1), #all do
        if all[i]:find("%S") then table.insert(lines, all[i]) end
    end
    return table.concat(lines, "\n")
end

local function has(text, part) return text:find(part, 1, true) ~= nil end
-- The last `n` lines: what the pane shows now. Earlier lines are scrollback, which
-- can hold an exited view's last frame.
local function bottom(s, n)
    local lines = {}
    for line in s:gmatch("[^\n]+") do table.insert(lines, line) end
    return table.concat(lines, "\n", math.max(1, #lines - n + 1))
end
-- The agents list, its new-task prompt empty.
local function isList(s)
    local b = bottom(s, 4)
    return has(b, "describe a task for a new session") and not has(b, "⌕")
end
-- The prompt line: the last "❯" line near the bottom. What a session draws below
-- it varies (a custom status line replaces the mode and "← N agent" hints, and
-- can take several lines), so the prompt is the landmark to go by.
local function promptLine(s)
    local last
    for line in bottom(s, 10):gmatch("[^\n]+") do
        if line:match("^%s*❯") then last = line end
    end
    return last
end
-- A session opened in the view: a ❯ prompt and none of the list's own markers.
local function isSession(s)
    local b, footer = bottom(s, 10), bottom(s, 2)
    return promptLine(s) ~= nil and not has(b, "⌕") and not has(b, "describe a task for a new session")
        and not (has(footer, "enter to open") or has(footer, "enter to return") or has(footer, "enter to create"))
end
-- A session whose prompt holds no text: ← there goes back to the list, and typing
-- there writes a fresh message.
local function isEmptySession(s)
    local line = isSession(s) and promptLine(s)
    return line and line:match("^%s*❯%s*$") ~= nil or false
end
local function isFind(s) return has(bottom(s, 4), "⌕") end

-- Text after ❯ can be Claude Code's dimmed prompt suggestion rather than a draft,
-- and the pane's text can't tell them apart. So type a marker and look: in an empty
-- prompt (suggestion or not) the line becomes just the marker; in a draft the
-- marker joins it. A backspace then takes the marker out, leaving a draft as it was.
local MARK = "§"
local PROBE_LOG = HOME .. "/.cache/cc-pr/probe.log"

-- Polls the pane every 0.25 s until `check(screenText)` holds (then onOk) or
-- `seconds` pass (then onFail).
local function waitFor(p, seconds, check, onOk, onFail)
    local deadline = hs.timer.secondsSinceEpoch() + seconds
    if M.timer then M.timer:stop() end
    M.timer = hs.timer.doEvery(0.25, function()
        local s = screen(p)
        if check(s) then
            M.timer:stop()
            onOk(s)
        elseif hs.timer.secondsSinceEpoch() > deadline then
            M.timer:stop()
            onFail(s)
        end
    end)
end

-- A session with a long history can take seconds to redraw after a keystroke, so
-- the marker is waited for (and its removal too) rather than read after a fixed delay.
-- Each verdict goes to PROBE_LOG with the line it was based on.
local function probeEmpty(p, onEmpty, onDraft)
    local function marked(s) return (promptLine(s) or ""):find(MARK, 1, true) ~= nil end
    local function log(verdict, line)
        local f = io.open(PROBE_LOG, "a")
        if f then
            f:write(os.date("%F %T "), verdict, "\t", line or "(no prompt line)", "\n")
            f:close()
        end
    end
    local before = promptLine(screen(p))
    send(p, quoted(MARK))
    waitFor(p, 5, marked, function(s)
        local line = promptLine(s)
        local empty = line:match("^%s*❯%s*" .. MARK .. "%s*$") ~= nil
        log(empty and "empty" or "draft", line)
        send(p, KEY.backspace)
        waitFor(p, 5, function(s2) return not marked(s2) end, function()
            if empty then onEmpty() else onDraft() end
        end, function(s2)
            log("marker stuck", promptLine(s2))
            onDraft()
        end)
    end, function(s)
        log("marker never showed; before: " .. (before or "?"), promptLine(s))
        send(p, KEY.backspace)
        onDraft()
    end)
end

-- Opens the session called `name` in the agents view in pane `p`, then, given a
-- `prompt`, types it into the session's empty prompt and sends it.
local function openInView(p, name, title, prompt)
    local function stop(why)
        hs.alert.show(string.format("cc-pr: %s; %s is in your agents list", why, title), 5)
    end
    local function ask()
        if not prompt then return end
        local function typeIt()
            send(p, quoted(prompt))
            M.settle = hs.timer.doAfter(0.6, function()
                -- Only send what the prompt now shows; anything else stays unsent.
                if not has(bottom(screen(p), 10), prompt:sub(1, 30)) then
                    return stop("the request didn't show in its prompt, so it wasn't sent")
                end
                send(p, KEY.enter)
                hs.alert.show("Sent to " .. title, 3)
            end)
        end
        waitFor(p, 3, isSession, function(s)
            if isEmptySession(s) then return typeIt() end
            probeEmpty(p, typeIt, function() stop("its prompt has a draft, so the request wasn't typed") end)
        end, function() stop("it didn't open") end)
    end
    local function findIt()
        send(p, KEY.find)
        waitFor(p, 3, isFind, function()
            send(p, quoted(name))
            -- The filter settles a moment after the last key.
            M.settle = hs.timer.doAfter(0.8, function()
                local s = screen(p)
                if has(bottom(s, 8), "no sessions match") then
                    send(p, KEY.esc)
                    return stop("couldn't find it by name")
                end
                -- Long names are cut short in the list.
                local prefix, rows = name:sub(1, 24), 0
                for line in bottom(s, 12):gmatch("[^\n]+") do
                    if not has(line, "⌕") and has(line, prefix) then rows = rows + 1 end
                end
                if rows > 1 then
                    return hs.alert.show("cc-pr: several sessions are named that; pick one in the list", 5)
                end
                -- "enter to return" for the session the view had open last.
                local footer = bottom(s, 2)
                if rows ~= 1 or not (has(footer, "enter to open") or has(footer, "enter to return")) then
                    send(p, KEY.esc)
                    return stop("the list didn't show it as expected")
                end
                send(p, KEY.enter)
                waitFor(p, 5, isSession, ask, function() stop("it didn't open") end)
            end)
        end, function() stop("the find box didn't open") end)
    end

    waitFor(p, 20, function(s) return isList(s) or isSession(s) or isFind(s) end, function(s)
        if isFind(s) then
            send(p, KEY.esc)
            return waitFor(p, 3, isList, findIt, function() stop("the view didn't settle") end)
        end
        if isList(s) then return findIt() end
        -- A session is open in the view: ← goes back to the list when its prompt is
        -- empty; with a draft in it, ← would only move the cursor, so stop there.
        -- Within 2 s of the prompt being emptied by editing (probeEmpty's backspace,
        -- or the user's own), Claude Code's ← only arms ("Press ← again") and a second
        -- press, 150 ms to 3 s later, goes back.
        local function back()
            local function failed() stop("← didn't go back to the agents list") end
            send(p, KEY.left)
            waitFor(p, 1, isList, findIt, function(s2)
                if not isSession(s2) then return failed() end
                send(p, KEY.left)
                waitFor(p, 3, isList, findIt, failed)
            end)
        end
        if isEmptySession(s) then return back() end
        probeEmpty(p, back, function() stop("a session open in that pane has a draft in its prompt") end)
    end, function() stop("the agents view didn't show up") end)
end

local function newWindow()
    local ok, out = osa(string.format([[
        tell application "iTerm"
            activate
            set w to (create window with default profile)
            tell current session of w to write text %s
            return (id of w as string) & (character id 9) & (unique id of current session of w) & (character id 9) & (tty of current session of w)
        end tell
    ]], quoted(AGENTS_COMMAND)))
    if not ok then return nil end
    local win, uid, tty = (out or ""):match("^(%d+)\t([^\t]+)\t(.+)$")
    return win and { win = win, uid = uid, tty = tty } or nil
end

-- The agents pane to use, and whether it must be restarted as AGENTS_COMMAND: a
-- flagless view would start new sessions in auto mode, and an attached session's ←
-- opens one.
local function pickPane(onlyWin)
    local target, best, frontWin, restart = nil, -1, nil, false
    for _, p in ipairs(panes()) do
        local pgid, cmd
        if not onlyWin or p.win == onlyWin then pgid, cmd = agentsView(p.tty) end
        if pgid then
            frontWin = frontWin or p.win
            local attach = cmd:match("^%S*claude attach") ~= nil
            local flagged = cmd:match("%-%-dangerously%-skip%-permissions") or cmd:match("%-%-permission%-mode")
            local fine = not attach and (flagged ~= nil or not M.dangerouslySkipPermissions)
            local rank = (fine and 2 or 0) + (p.current and 1 or 0)
            if p.win == frontWin and rank > best then
                target, best, restart = p, rank, not fine
                target.pgid = pgid
            end
        end
    end
    return target, restart
end

-- Shows the background session called `name` in an agents view (see openInView).
local function showInView(name, title, prompt, onlyWin)
    local p, restart = pickPane(onlyWin)
    if not p then
        p = newWindow()
        if not p then return end
    elseif restart then
        hs.execute("kill -TERM -" .. p.pgid)
        -- Start the view only once the old one has let go of the terminal.
        local tries = 0
        if M.timer then M.timer:stop() end
        M.timer = hs.timer.doEvery(0.1, function()
            tries = tries + 1
            if agentsView(p.tty) and tries < 30 then return end
            M.timer:stop()
            send(p, quoted(AGENTS_COMMAND), true)
            focus(p)
            if name ~= "" then openInView(p, name, title, prompt) end
        end)
        return
    end
    focus(p)
    if name == "" then
        hs.alert.show(title .. " is in your agents list", 4)
    else
        openInView(p, name, title, prompt)
    end
end

local function taskEnv()
    local env = { HOME = HOME, USER = ME, PATH = PATH }
    if M.dangerouslySkipPermissions then env.CC_PR_CLAUDE = "claude --dangerously-skip-permissions" end
    return env
end

-- Runs cc-pr with `args`; on success calls onDone with the name it reports.
local function runCcPr(args, env, onDone)
    -- Held so the task isn't garbage-collected while it runs.
    M.task = hs.task.new(CC_PR, function(code, out, err)
        if code ~= 0 then
            hs.alert.show(((err or ""):match("[^\n]+") or ("cc-pr: exit " .. code)), 4)
            return
        end
        onDone((out or ""):match("%x+\t([^\n]*)") or "")
    end, args)
    M.task:setEnvironment(env)
    M.task:start()
end

-- Resumes a transcript (from cc-pr --list) as a background agent and opens it in an
-- agents view, sending `prompt` to it when given. onlyWin (an iTerm window id)
-- confines the pane search to one window, for testing without touching the others.
function M.open(file, title, onlyWin, prompt)
    if not file:match("^/[%w%._/%-]+%.jsonl$") then
        hs.alert.show("cc-pr: ignoring odd transcript path")
        return
    end
    title = title or "The session"
    runCcPr({ "--no-attach", "--open", file }, taskEnv(), function(name)
        showInView(name, title, prompt, onlyWin)
    end)
end

-- A request from the ADO Toolbox's "Local sessions" (PR side pane), handed over
-- by the local service (ado-companion) as a JSON file it wrote:
-- {file, title, prompt}. Read once and deleted; an empty prompt only opens the
-- session. Returns "ok" to the service's `hs -c`.
function M.request(path)
    if type(path) ~= "string" or not path:match("^" .. HOME .. "/%.cache/cc%-pr/requests/%x+%.json$") then
        return "bad request path"
    end
    local req = hs.json.read(path)
    os.remove(path)
    if type(req) ~= "table" or type(req.file) ~= "string" then return "bad request" end
    local prompt = type(req.prompt) == "string" and req.prompt ~= "" and req.prompt or nil
    local title = type(req.title) == "string" and req.title or nil
    -- `win` (an iTerm window id) is for tests; the service never writes it.
    local win = req.win and tostring(req.win):match("^%d+$") or nil
    -- Off the IPC call: opening drives iTerm for several seconds.
    M.pending = hs.timer.doAfter(0.05, function() M.open(req.file, title, win, prompt) end)
    return "ok"
end

-- Starts a new background session called `name` on `prompt` (in the profile
-- NEW_SESSION_CONFIG_DIR) and opens it in an agents view.
function M.start(name, prompt, onlyWin)
    local env = taskEnv()
    if NEW_SESSION_CONFIG_DIR then env.CLAUDE_CONFIG_DIR = NEW_SESSION_CONFIG_DIR end
    runCcPr({ "--start", name, prompt }, env, function(started)
        showInView(started, name, nil, onlyWin)
    end)
end

-- Held while open (and reachable for tests).
M.chooser = nil

local function show(id, rows)
    local choices = {}
    for line in rows:gmatch("[^\n]+") do
        local file, title, cwd, mtime, live = line:match("^([^\t]*)\t([^\t]*)\t([^\t]*)\t(%d+)\t?([^\t]*)$")
        if file then
            local where = (cwd:gsub("^" .. HOME:gsub("%p", "%%%0"), "~"))
            local status = live == "background" and " · running in background"
                or live == "interactive" and " · open in another terminal" or ""
            table.insert(choices, {
                text = title ~= "" and title or "untitled",
                subText = string.format("%s · %s%s", os.date("%m-%d %H:%M", tonumber(mtime)), where, status),
                file = file,
                live = live,
            })
        end
    end
    if #choices == 0 then
        hs.alert.show("cc-pr: no local Claude session mentions PR " .. id)
        return
    end
    local function pick(choice)
        if not choice then return end
        if choice.live == "interactive" then
            hs.alert.show("cc-pr: that session is open in another terminal; switch to it there", 4)
            return
        end
        M.open(choice.file, choice.text)
    end
    if #choices == 1 then
        pick(choices[1])
        return
    end
    M.chooser = hs.chooser.new(pick)
    M.chooser:placeholderText("Claude sessions on PR " .. id .. " — opens it in your agents view")
    M.chooser:choices(choices)
    M.chooser:show()
end

-- hammerspoon://cc-thread?org=…&project=…&repo=…&pr=12441&thread=128027 — fired by
-- the Toolbox's "Send to Claude Code" button on a PR comment thread. cc-pr fetches
-- the thread and writes it, with what to do, to a file; the chooser names the
-- comment and offers the PR's sessions plus a new one. Picking one is the
-- confirmation (any page can open the URL): an existing session gets a one-line
-- request pointing at the file, typed into it in the agents view; a new session
-- starts on that request.
local function sendThread(params)
    local org, project, repo = params.org or "", params.project or "", params.repo or ""
    local pr, thread = params.pr or "", params.thread or ""
    if not (org:match("^[%w%-]+$") and project:match("^[%w%._ %-]+$") and repo:match("^[%w%._%-]+$")
        and pr:match("^%d+$") and thread:match("^%d+$")) then
        hs.alert.show("cc-thread: ignoring a malformed request")
        return
    end
    local env = { HOME = HOME, USER = ME, PATH = PATH }
    M.task = hs.task.new(CC_PR, function(code, out, err)
        if code ~= 0 then
            hs.alert.show(((err or ""):match("[^\n]+") or ("cc-pr: exit " .. code)), 5)
            return
        end
        local file, summary, _, branch = (out or ""):match("^([^\t]+)\t([^\t]*)\t([^\t]*)\t([^\t\n]*)")
        if not file then return hs.alert.show("cc-thread: couldn't read the thread") end
        local prompt = string.format(
            "PR !%s comment thread %s: do what it asks. Read the thread and these instructions first: %s",
            pr, thread, file)
        local comment = (summary:match("^[^:]*:%s*(.*)$") or summary):gsub("[%c\"]", " ")
        local newName = string.format("pr %s thread %s: %s", pr, thread, comment:sub(1, 40))

        M.task = hs.task.new(CC_PR, function(_, rows)
            local choices = {}
            for line in (rows or ""):gmatch("[^\n]+") do
                local f, title, cwd, mtime, live = line:match("^([^\t]*)\t([^\t]*)\t([^\t]*)\t(%d+)\t?([^\t]*)$")
                if f then
                    local where = (cwd:gsub("^" .. HOME:gsub("%p", "%%%0"), "~"))
                    local status = live == "background" and " · running in background"
                        or live == "interactive" and " · open in another terminal" or ""
                    table.insert(choices, {
                        text = title ~= "" and title or "untitled",
                        subText = string.format("%s · %s%s", os.date("%m-%d %H:%M", tonumber(mtime)), where, status),
                        file = f,
                        live = live,
                    })
                end
            end
            table.insert(choices, { text = "New session for this thread", subText = newName, new = true })
            M.chooser = hs.chooser.new(function(choice)
                if not choice then return end
                if choice.new then return M.start(newName, prompt) end
                if choice.live == "interactive" then
                    return hs.alert.show("cc-pr: that session is open in another terminal; switch to it there", 4)
                end
                M.open(choice.file, choice.text, nil, prompt)
            end)
            M.chooser:placeholderText(string.format("Send “%s” (PR !%s) to…", summary:sub(1, 70), pr))
            M.chooser:choices(choices)
            M.chooser:show()
        end, { "--list", pr, branch ~= "" and branch:match("^[%w%._/][%w%._/%-]*$") and branch or nil })
        M.task:setEnvironment(env)
        M.task:start()
    end, { "--thread-context", org, project, repo, pr, thread })
    M.task:setEnvironment(env)
    M.task:start()
end

function M.setup(opts)
    opts = opts or {}
    if opts.dangerouslySkipPermissions ~= nil then M.dangerouslySkipPermissions = opts.dangerouslySkipPermissions == true end
    if type(opts.agentsCommand) == "string" and opts.agentsCommand ~= "" then AGENTS_COMMAND = opts.agentsCommand end
    if type(opts.newSessionConfigDir) == "string" and opts.newSessionConfigDir ~= "" then
        NEW_SESSION_CONFIG_DIR = (opts.newSessionConfigDir:gsub("^~", HOME))
    end
    hs.urlevent.bind("cc-thread", function(_, params) sendThread(params or {}) end)
    hs.urlevent.bind("cc-pr", function(_, params)
        local id = params and params.id or ""
        local branch = params and params.branch or ""
        if not id:match("^%d+$") then
            hs.alert.show("cc-pr: ignoring bad pull request id " .. tostring(id))
            return
        end
        if branch ~= "" and not branch:match("^[%w%._/][%w%._/%-]*$") then
            hs.alert.show("cc-pr: ignoring bad branch " .. tostring(branch))
            branch = ""
        end
        local args = { "--list", id }
        if branch ~= "" then table.insert(args, branch) end
        local task = hs.task.new(CC_PR, function(code, out, err)
            if code ~= 0 then
                hs.alert.show("cc-pr: " .. ((err or ""):match("[^\n]+") or ("exit " .. code)), 4)
                return
            end
            show(id, out or "")
        end, args)
        task:setEnvironment({ HOME = HOME, USER = ME, PATH = PATH })
        task:start()
    end)
end

return M
