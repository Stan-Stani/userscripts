-- The focus timer in the menu bar. ado-companion keeps the timer (GET/POST /focus;
-- the rules are in focus.mjs beside this file), so the menu bar and the review clock
-- on PR pages always agree; this file only shows it and sends your clicks. Loaded
-- from ~/.hammerspoon/init.lua with require("focus").setup{}.
--
-- The title is the time left, plus the PR the review clock is timing. The menu
-- holds the actions for the phase you're in, the bank and today's totals. When a
-- block ends a notification offers Take break / Skip, bank it / 5 more minutes
-- (its buttons show when Hammerspoon's notifications are set to Alerts in System
-- Settings); when a break ends, another offers Start focus.
local M = {}

local URL = "http://127.0.0.1:47811/focus"
local HEADERS = { ["Content-Type"] = "application/json", ["X-ADO-Toolbox"] = "1" }

M.bar = nil
M.timer = nil
local last = nil -- the last answer from /focus
local lastAt = 0 -- when it came, in seconds
local down = false
local polling = false
local seen = nil -- the phaseId already announced
local note = nil -- the notification up now

local COLORS = {
  focus = { red = 0.84, green = 0.10, blue = 0.13 },
  due = { red = 0.85, green = 0.55, blue = 0.00 },
  ["break"] = { red = 0.05, green = 0.58, blue = 0.53 },
  ready = { white = 0.55 },
}

local function now() return hs.timer.secondsSinceEpoch() end

-- Time left, counted down locally between answers.
local function remaining(f)
  if not f.running then return f.remaining end
  return math.max(0, f.remaining - (now() - lastAt) * 1000)
end

local function clock(ms)
  local s = math.max(0, math.ceil(ms / 1000))
  return string.format("%d:%02d", s // 60, s % 60)
end

local function span(seconds)
  local m = math.floor(seconds / 60 + 0.5)
  if m >= 60 then return string.format("%dh %02dm", m // 60, m % 60) end
  return m .. "m"
end

local function reviewing(f)
  return f.review and f.review.running and f.review or nil
end

local function title()
  local f = last
  local text, color
  if down or not f then
    text, color = "focus ?", COLORS.ready
  else
    color = COLORS[f.phase] or COLORS.ready
    if f.phase == "focus" then
      text = clock(remaining(f)) .. (f.running and "" or (f.pausedBy == "idle" and " away" or " paused"))
      local r = reviewing(f)
      if r then text = text .. " · !" .. r.pr end
    elseif f.phase == "due" then
      text = "break due"
    elseif f.phase == "break" then
      text = "break " .. clock(remaining(f)) .. (f.running and "" or " paused")
    else
      text = "focus"
    end
  end
  local font = hs.styledtext.defaultFonts.menuBar
  return hs.styledtext.new("● ", { color = color, font = font }) .. hs.styledtext.new(text, { font = font })
end

local function redraw()
  if M.bar then M.bar:setTitle(title()) end
end

local apply

local function post(body)
  hs.http.asyncPost(URL, hs.json.encode(body), HEADERS, function(status, response)
    local ok, f = pcall(hs.json.decode, response or "")
    if (status == 200 or status == 409) and ok and type(f) == "table" then
      apply(f, true)
      if status == 409 and f.error then hs.alert.show("Focus: " .. f.error) end
    else
      hs.alert.show("Focus: ado-companion didn't answer")
    end
  end)
end

local function withdraw()
  if note then
    note:withdraw()
    note = nil
  end
end

-- A notification when a block or a break runs out (once per phase). Nothing for a
-- change you just made from the menu, nor on the first answer after a (re)load.
local function announce(f, previous, previousLeft, clicked)
  if f.phaseId == seen then return end
  local first = seen == nil
  seen = f.phaseId
  withdraw()
  if first or clicked then return end
  if f.phase == "due" then
    local skip = "Skip, bank " .. f.breakMin .. " min"
    local r = reviewing(f) or (previous and reviewing(previous))
    note = hs.notify.new(function(n)
      local kind = n:activationType()
      if kind == hs.notify.activationTypes.actionButtonClicked then
        post({ action = "take" })
      elseif kind == hs.notify.activationTypes.additionalActionClicked then
        local which = n:additionalActivationAction()
        if which == skip then post({ action = "skip" }) elseif which == "5 more minutes" then post({ action = "snooze" }) end
      end
    end, {
      title = "Break due · " .. f.breakMin .. " min",
      informativeText = "Block " .. f.block .. " of " .. f.longEvery .. " done." ..
        (r and (" The review clock on !" .. r.pr .. " waits for you.") or ""),
      hasActionButton = true,
      actionButtonTitle = "Take break",
      additionalActions = { skip, "5 more minutes" },
      withdrawAfter = 0,
    })
    note:send()
  elseif f.phase == "ready" and previous and previous.phase == "break" and previousLeft < 5000 then
    note = hs.notify.new(function(n)
      if n:activationType() == hs.notify.activationTypes.actionButtonClicked then post({ action = "start" }) end
    end, {
      title = "Break over",
      informativeText = "Next: block " .. f.block .. " of " .. f.longEvery .. ".",
      hasActionButton = true,
      actionButtonTitle = "Start focus",
      withdrawAfter = 0,
    })
    note:send()
  end
end

apply = function(f, clicked)
  local previous = last
  local previousLeft = previous and remaining(previous) or 0
  last, lastAt, down = f, now(), false
  announce(f, previous, previousLeft, clicked)
  redraw()
end

local function poll()
  if polling then return end
  polling = true
  hs.http.asyncGet(URL, nil, function(status, response)
    polling = false
    local ok, f = pcall(hs.json.decode, response or "")
    if status == 200 and ok and type(f) == "table" then
      apply(f)
    else
      down = true
      redraw()
    end
  end)
end

local function restartCompanion()
  local uid = hs.execute("/usr/bin/id -u"):gsub("%s+", "")
  hs.task.new("/bin/launchctl", nil, { "kickstart", "-k", "gui/" .. uid .. "/com.ado-companion" }):start()
end

local function choices(label, key, options, current)
  local items = {}
  for _, n in ipairs(options) do
    items[#items + 1] = { title = n .. " min", checked = current == n, fn = function() post({ action = "settings", [key] = n }) end }
  end
  return { title = label, menu = items }
end

local function menu()
  local f = last
  if down or not f then
    return {
      { title = "ado-companion isn't answering", disabled = true },
      { title = "Restart ado-companion", fn = restartCompanion },
    }
  end
  local items = {}
  local function add(item) items[#items + 1] = item end
  local function info(text) add({ title = text, disabled = true }) end
  local left = clock(remaining(f))
  local block = "block " .. f.block .. " of " .. f.longEvery
  if f.phase == "focus" then
    info((f.running and "Focus" or (f.pausedBy == "idle" and "Paused while you were away" or "Paused")) .. " · " .. block .. " · " .. left .. " left")
  elseif f.phase == "due" then
    info("Break due · " .. f.breakMin .. " min · after " .. block)
  elseif f.phase == "break" then
    info("Break · " .. left .. " left" .. (f.fromBankMin > 0 and (" (" .. f.fromBankMin .. " min from the bank)") or ""))
  else
    info("Ready · next is " .. block)
  end
  local r = reviewing(f)
  if r then info("Reviewing !" .. r.pr .. " (" .. r.repo .. ") · " .. clock(r.seconds * 1000)) end
  add({ title = "-" })

  if f.phase == "ready" then
    add({ title = "Start focus (" .. f.settings.focusMin .. " min)", fn = function() post({ action = "start" }) end })
  elseif f.phase == "focus" or f.phase == "break" then
    if f.running then
      add({ title = "Pause", fn = function() post({ action = "pause" }) end })
    else
      add({ title = "Resume", fn = function() post({ action = "resume" }) end })
    end
    if f.phase == "focus" then
      add({ title = "Take a break now", fn = function() post({ action = "breakNow" }) end })
    else
      add({ title = "End break early (unused minutes go to the bank)", fn = function() post({ action = "endBreak" }) end })
    end
  elseif f.phase == "due" then
    add({ title = "Take " .. f.breakMin .. " min break", fn = function() post({ action = "take" }) end })
    local bankMin = math.floor(f.bank / 60000)
    if bankMin > 0 then
      local more = {}
      for _, n in ipairs({ 5, 10, 15, 30 }) do
        if n < bankMin then
          more[#more + 1] = { title = "+" .. n .. " min (" .. (f.breakMin + n) .. " min break)", fn = function() post({ action = "take", add = n }) end }
        end
      end
      more[#more + 1] = { title = "All " .. span(bankMin * 60) .. " (" .. span((f.breakMin + bankMin) * 60) .. " break)", fn = function() post({ action = "take", add = bankMin }) end }
      add({ title = "Take a longer break from the bank", menu = more })
    end
    add({ title = "Skip, bank " .. f.breakMin .. " min", fn = function() post({ action = "skip" }) end })
    add({ title = "5 more minutes", fn = function() post({ action = "snooze" }) end })
  end
  if f.phase ~= "ready" then add({ title = "Stop", fn = function() post({ action = "stop" }) end }) end

  add({ title = "-" })
  info("Bank: " .. span(f.bank / 1000))
  local t = f.today
  info("Today: focus " .. span(t.focusSeconds) .. " (" .. t.blocks .. (t.blocks == 1 and " block" or " blocks") ..
    ") · breaks " .. span(t.breakSeconds) .. " · PR reviews " .. span(t.prSeconds))
  add({ title = "-" })
  add({ title = "Settings", menu = {
    choices("Focus block", "focusMin", { 25, 45, 50 }, f.settings.focusMin),
    choices("Break", "breakMin", { 5, 10 }, f.settings.breakMin),
    choices("Long break (every " .. f.settings.longEvery .. "th)", "longBreakMin", { 15, 20, 30 }, f.settings.longBreakMin),
  } })
  return items
end

-- For testing from `hs -c`: the last answer, and a way to act.
function M.state() return last end
function M.act(body) post(body) end

function M.setup()
  if M.timer then M.timer:stop() end
  if M.bar then M.bar:delete() end
  M.bar = hs.menubar.new()
  M.bar:setMenu(menu)
  redraw()
  M.timer = hs.timer.doEvery(1, function()
    poll()
    redraw()
  end)
  poll()
  return M
end

return M
