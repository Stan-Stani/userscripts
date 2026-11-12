#!/usr/bin/env node
/**
 * ado-companion: the Azure DevOps Toolbox userscript's local service, on
 * http://127.0.0.1:47811 (loopback only). Set up with install.sh beside it; see
 * README.md there.
 *
 * Settings: ~/.config/ado-companion/config.json (ADO_COMPANION_CONFIG to move it),
 * read at start:
 *   org, project    the Azure DevOps organization and project /pr/<id> resolves in
 *   fallbackRepo    the repo /pr/<id> opens when the id can't be resolved
 *   patEnvFile      a file with an AZDO_PAT=… line (used when AZDO_PAT isn't set)
 * pr-review-sync reads judgmentLogUrl and claudeConfigDir from the same file.
 *
 * /pr/<id>: ADO PR ids are unique per project, but every *web* URL is repo-scoped and
 * 404s with the wrong repo — and there is no repo-less web route (verified:
 * /_git/pullrequest/<id> and /_pulls/<id> both 404). Only the project-level
 * REST API resolves an id to its repo.
 *
 * Claude Code's `footerLinksRegexes` maps a regex to a STATIC url template, so
 * a bare "PR 11528" mention cannot know its repo. This service closes that gap:
 * badges point at http://127.0.0.1:47811/pr/<id>, which resolves the repo via
 * the API and 302s to the real PR page.
 *
 * Binds loopback only. Ids are validated as digits (no SSRF via path).
 * Auth: AZDO_PAT env, else the PAT line in patEnvFile, else an `az` token.
 * Resolutions are permanent (a PR never changes repo), so they are cached to
 * disk and reused forever.
 *
 * GET /claude-sessions?ids=session_A,session_B: the local names of the claude.ai
 * sessions that PR commits link to. See sessionNames.
 *
 * And the Toolbox's PR review clock:
 *   GET  /idle             → {"idle": <seconds since the last keyboard or mouse input>}
 *   GET  /review-sessions  → logged reviews, [?repo=<name>&pr=<id>] to one PR's
 *   POST /review-sessions  {"op":"put","session":{…}} or {"op":"delete","id":"…"}
 * Reviews live in REVIEW_LOG, one event per line (a later put of an id replaces
 * it; a delete removes it). pr-review-sync copies them into the Judgment Log.
 * A POST must be JSON and carry X-ADO-Toolbox: 1. A web page can only send that
 * after a CORS preflight, which this service never answers, so only the
 * userscript (GM_xmlhttpRequest is exempt from CORS) can write.
 *
 * And the Toolbox's "Local sessions" in a PR's side pane:
 *   GET  /pr-sessions?pr=<id>[&branch=<name>]  → the PR's local Claude Code sessions (cc-pr --list)
 *   POST /pr-sessions/send {"id": "<session uuid>", "prompt"?: "…"}
 * The POST (same JSON + header rule) hands the session, and the request typed on
 * the PR page, to Hammerspoon's ccpr.request, which opens it in an agents view
 * and types the request there.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const PORT = 47811
const CONFIG_FILE = process.env.ADO_COMPANION_CONFIG || join(homedir(), '.config/ado-companion/config.json')
const expandHome = (p) => (typeof p === 'string' ? p.replace(/^~(?=\/|$)/, homedir()) : '')
let config = {}
try {
  config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
} catch {
  /* no settings yet: /pr/<id> answers with how to add them */
}
const ORG = typeof config.org === 'string' ? config.org : ''
const PROJECT = typeof config.project === 'string' ? config.project : ''
const FALLBACK_REPO = typeof config.fallbackRepo === 'string' ? config.fallbackRepo : ''
const ENV_FILE = expandHome(config.patEnvFile)
const CACHE_FILE = join(homedir(), '.local/share/ado-companion/repo-map.json')
const API_TIMEOUT_MS = 4000

const webUrl = (repo, id) =>
  `https://dev.azure.com/${encodeURIComponent(ORG)}/${encodeURIComponent(PROJECT)}` +
  `/_git/${encodeURIComponent(repo)}/pullrequest/${id}`

let cache = {}
try {
  cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
} catch {
  /* first run */
}

const saveCache = () => {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(cache))
  } catch {
    /* cache is best-effort */
  }
}

const getAuthHeader = () => {
  let pat = process.env.AZDO_PAT || process.env.AZURE_DEVOPS_EXT_PAT
  if (!pat && ENV_FILE) {
    try {
      const line = readFileSync(ENV_FILE, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('AZDO_PAT='))
      if (line) pat = line.slice('AZDO_PAT='.length).trim().replace(/^"|"$/g, '')
    } catch {
      /* no env file */
    }
  }
  if (pat) return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`

  try {
    const token = execFileSync(
      'az',
      ['account', 'get-access-token', '--resource',
       '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '-o', 'tsv'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    ).trim()
    if (token) return `Bearer ${token}`
  } catch {
    /* az unavailable */
  }
  return null
}

const resolveRepo = async (id) => {
  if (cache[id]) return cache[id]

  const auth = getAuthHeader()
  if (!auth) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://dev.azure.com/${encodeURIComponent(ORG)}/${encodeURIComponent(PROJECT)}` +
        `/_apis/git/pullrequests/${id}?api-version=7.1`,
      { headers: { Authorization: auth, Accept: 'application/json' }, signal: controller.signal }
    )
    if (!res.ok) return null
    const repo = (await res.json())?.repository?.name
    if (!repo) return null
    cache[id] = repo
    saveCache()
    return repo
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const SESSION_ID = /^session_[A-Za-z0-9]{1,64}$/
const MAX_SESSION_IDS = 50
const NAME_TYPES = ['agent-name', 'custom-title', 'ai-title']

// rg exits 1 when nothing matches; that's an empty answer, not a failure.
const rg = async (args) => {
  try {
    const { stdout } = await promisify(execFile)('rg', args, { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (e) {
    if (e.code === 1) return ''
    throw e
  }
}

// Background sessions keep the bridged id in their job record,
// <config>/jobs/<id>/state.json ("bridgeSessionId", with the name `claude agents`
// shows); newer ones record it nowhere else.
const jobNames = (ids) => {
  const wanted = new Map(ids.map((id) => [`cse_${id.slice('session_'.length)}`, id]))
  const names = {}
  for (const dir of readdirSync(homedir()).filter((d) => d.startsWith('.claude'))) {
    const jobs = join(homedir(), dir, 'jobs')
    if (!existsSync(jobs)) continue
    for (const job of readdirSync(jobs)) {
      try {
        const state = JSON.parse(readFileSync(join(jobs, job, 'state.json'), 'utf8'))
        const id = wanted.get(state.bridgeSessionId)
        if (id && state.name && state.sessionId) names[id] = { name: state.name, sessionId: state.sessionId }
      } catch {
        /* no or partly written state */
      }
    }
  }
  return names
}

// claude.ai session id → { name, sessionId }: from its background job record, else
// from the local transcript that bridged it, which records the same id as
// "bridgeSessionId":"cse_<rest>". The name is what `claude agents` shows: the agent
// name, else a /rename title, else the auto title. Ids found in neither are left out.
const sessionNames = async (ids) => {
  const fromJobs = jobNames(ids)
  ids = ids.filter((id) => !fromJobs[id])
  const roots = readdirSync(homedir())
    .filter((d) => d.startsWith('.claude'))
    .map((d) => join(homedir(), d, 'projects'))
    .filter((d) => existsSync(d))
  if (!roots.length || !ids.length) return fromJobs

  const bridged = ids.map((id) => `"bridgeSessionId":"cse_${id.slice('session_'.length)}"`)
  // -m1: a transcript records its bridge id near the top, so stop reading there.
  const out = await rg(['--null', '--no-messages', '-o', '-m1', '-F', '-g', '*.jsonl', '-g', '!subagents',
    ...bridged.flatMap((p) => ['-e', p]), ...roots])
  // A resumed or forked session can bridge the same id from several transcripts;
  // the newest one carries the current name.
  const newest = {}
  for (const line of out.split('\n').filter(Boolean)) {
    const [file, hit] = line.split('\0')
    const id = `session_${hit.slice('"bridgeSessionId":"cse_'.length, -1)}`
    const mtime = statSync(file).mtimeMs
    if (!newest[id] || mtime > newest[id].mtime) newest[id] = { file, mtime }
  }

  const names = {}
  for (const [id, { file }] of Object.entries(newest)) {
    const entries = (await rg(['--no-filename', '-o',
      '"type":"(agent-name|custom-title|ai-title)","(agentName|customTitle|aiTitle)":"(?:[^"\\\\]|\\\\.)*"', file]))
      .split('\n').filter(Boolean)
      .map((fragment) => JSON.parse(`{${fragment}}`))
    const last = (type) => entries.filter((e) => e.type === type).pop()
    const named = NAME_TYPES.map(last).find(Boolean)
    const name = named && (named.agentName ?? named.customTitle ?? named.aiTitle)
    if (name) names[id] = { name, sessionId: file.split('/').pop().replace(/\.jsonl$/, '') }
  }
  return { ...names, ...fromJobs }
}

// --- PR review clock ---
const REVIEW_LOG = join(homedir(), '.local/share/pr-review/sessions.jsonl')
const MAX_BODY = 16 * 1024

// Seconds since the last keyboard or mouse input anywhere on the Mac.
let idleCache = { at: 0, idle: 0 }
const idleSeconds = async () => {
  if (Date.now() - idleCache.at < 2000) return idleCache.idle
  const { stdout } = await promisify(execFile)('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 3000 })
  const ns = /"HIDIdleTime" = (\d+)/.exec(stdout)?.[1]
  if (!ns) throw new Error('no HIDIdleTime in ioreg output')
  idleCache = { at: Date.now(), idle: Math.floor(Number(ns) / 1e9) }
  return idleCache.idle
}

const SESSION_ID_RE = /^[A-Za-z0-9]{8,40}$/
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null)
const MS_2020 = 1577836800000
const MS_2100 = 4102444800000

// Only known fields, each checked and capped; null when a required one is off.
const cleanSession = (s) => {
  if (!s || typeof s !== 'object') return null
  const out = {
    id: SESSION_ID_RE.test(s.id) ? s.id : null,
    activity: 'pr-review',
    org: str(s.org, 100),
    project: str(s.project, 100),
    repo: str(s.repo, 100),
    pr: int(s.pr, 1, 1e9),
    title: str(s.title, 300),
    start: int(s.start, MS_2020, MS_2100),
    end: int(s.end, MS_2020, MS_2100),
    seconds: int(s.seconds, 0, 86400),
    outcome: str(s.outcome, 60),
    pass: int(s.pass, 1, 99) ?? 1,
    note: str(s.note, 500),
    manual: s.manual === true,
  }
  if (!out.id || !out.repo || !out.pr || !out.start || !out.end || out.seconds === null || out.end < out.start) return null
  out.label = `!${out.pr} ${out.title}`.trim()
  return out
}

// The log folded to its current sessions, oldest first.
const reviewSessions = () => {
  let text = ''
  try {
    text = readFileSync(REVIEW_LOG, 'utf8')
  } catch {
    return []
  }
  const byId = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (e.op === 'put' && e.session?.id) byId.set(e.session.id, e.session)
      else if (e.op === 'delete' && e.id) byId.delete(e.id)
    } catch {
      /* a torn line; skip it */
    }
  }
  return [...byId.values()].sort((a, b) => a.start - b.start)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const handleReviews = async (req, res, url) => {
  if (req.method === 'GET') {
    const repo = url.searchParams.get('repo')
    const pr = Number(url.searchParams.get('pr'))
    const all = reviewSessions()
    return sendJson(res, 200, repo && pr ? all.filter((s) => s.repo === repo && s.pr === pr) : all)
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST' })
  if (req.headers['x-ado-toolbox'] !== '1' || !String(req.headers['content-type']).startsWith('application/json')) {
    return sendJson(res, 403, { error: 'JSON with X-ADO-Toolbox: 1 only' })
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'bad JSON' })
  }
  let event
  if (body?.op === 'put') {
    const session = cleanSession(body.session)
    if (!session) return sendJson(res, 400, { error: 'bad session' })
    event = { op: 'put', at: Date.now(), session }
  } else if (body?.op === 'delete' && SESSION_ID_RE.test(body.id)) {
    event = { op: 'delete', at: Date.now(), id: body.id }
  } else {
    return sendJson(res, 400, { error: 'op must be put or delete' })
  }
  mkdirSync(dirname(REVIEW_LOG), { recursive: true })
  appendFileSync(REVIEW_LOG, JSON.stringify(event) + '\n')
  return sendJson(res, 200, { ok: true, session: event.session })
}

// --- a PR's local Claude Code sessions ---
const CC_PR = join(homedir(), '.local/bin/cc-pr')
const HS = '/opt/homebrew/bin/hs'
const REQUESTS = join(homedir(), '.cache/cc-pr/requests')
// launchd's PATH lacks cc-pr's tools (rg, jq, claude).
const TOOL_ENV = { ...process.env, PATH: `${join(homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }
const PR_ID_RE = /^\d{1,9}$/
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LIST_TTL_MS = 20000
const LIST_TIMEOUT_MS = 25000
const listCache = new Map() // "pr|branch" → { at, rows }
const listing = new Map() // "pr|branch" → the scan in flight, shared by callers

// Runs a tool with no stdin (something under cc-pr waits on an open one) in its
// own process group, which a timeout kills whole: killing only the shell left
// its pipeline scanning on.
const runTool = (cmd, args, env, timeout) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }, timeout)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${basename(cmd)} ${signal ? `timed out (${signal})` : `exited ${code}`}: ${err.trim().slice(0, 200)}`))
    })
  })

// sessionId → "background" | "interactive", from each profile's `claude agents`.
const liveSessions = async () => {
  const live = {}
  for (const dir of readdirSync(homedir()).filter((d) => /^\.claude(-|$)/.test(d) && existsSync(join(homedir(), d, 'projects')))) {
    const env = { ...TOOL_ENV }
    // The default profile keeps state in ~/.claude.json, which an explicit CLAUDE_CONFIG_DIR would skip.
    if (dir === '.claude') delete env.CLAUDE_CONFIG_DIR
    else env.CLAUDE_CONFIG_DIR = join(homedir(), dir)
    try {
      for (const s of JSON.parse(await runTool(join(homedir(), '.local/bin/claude'), ['agents', '--json'], env, 10000))) {
        if (s.sessionId) live[s.sessionId] = s.kind === 'background' ? `background ${s.status || ''}`.trim() : s.kind || 'live'
      }
    } catch {
      /* a profile with no agents service */
    }
  }
  return live
}

// cc-pr --list: every transcript whose prompts or Claude's own messages mention the
// PR (its URL, number or branch), newest first. `related` marks the ones named or
// filed after it (the number in the session's name or its folder); the rest only
// mention it.
const scanPrSessions = async (pr, branch) => {
  const [stdout, live] = await Promise.all([
    runTool(CC_PR, ['--list', pr, ...(branch ? [branch] : [])], { ...TOOL_ENV, CC_PR_LIVE: '0' }, LIST_TIMEOUT_MS),
    liveSessions(),
  ])
  const own = new RegExp(`(^|\\D)${pr}(\\D|$)`)
  return stdout.split('\n').filter(Boolean).slice(0, 25).map((line) => {
    const [file, title, cwd] = line.split('\t')
    const id = basename(file, '.jsonl')
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      /* gone since the scan */
    }
    return {
      id,
      title: title || '',
      // Sessions started in ~ (most of them) get no folder label.
      folder: cwd && cwd !== homedir() ? basename(cwd) : '',
      mtime,
      live: live[id] || '',
      related: own.test(title || '') || own.test(basename(cwd || '')),
    }
  }).filter((r) => UUID_RE.test(r.id))
}

const prSessions = async (pr, branch) => {
  const key = `${pr}|${branch}`
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.rows
  if (!listing.has(key)) {
    listing.set(key, scanPrSessions(pr, branch).then(
      (rows) => {
        listCache.set(key, { at: Date.now(), rows })
        return rows
      }
    ).finally(() => listing.delete(key)))
  }
  return listing.get(key)
}

// A session's transcript, by its id, in any ~/.claude* profile.
const transcriptOf = (id) => {
  for (const dir of readdirSync(homedir()).filter((d) => d.startsWith('.claude'))) {
    const projects = join(homedir(), dir, 'projects')
    if (!existsSync(projects)) continue
    for (const project of readdirSync(projects)) {
      const file = join(projects, project, `${id}.jsonl`)
      if (existsSync(file)) return file
    }
  }
  return null
}

const handlePrSessions = async (req, res, url) => {
  if (url.pathname === '/pr-sessions' && req.method === 'GET') {
    const pr = url.searchParams.get('pr') || ''
    const branch = url.searchParams.get('branch') || ''
    if (!PR_ID_RE.test(pr) || (branch && !BRANCH_RE.test(branch))) return sendJson(res, 400, { error: 'pr=<digits>[&branch=<name>]' })
    return sendJson(res, 200, await prSessions(pr, branch))
  }
  if (url.pathname !== '/pr-sessions/send' || req.method !== 'POST') return sendJson(res, 404, { error: 'not found' })
  if (req.headers['x-ado-toolbox'] !== '1' || !String(req.headers['content-type']).startsWith('application/json')) {
    return sendJson(res, 403, { error: 'JSON with X-ADO-Toolbox: 1 only' })
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'bad JSON' })
  }
  if (!UUID_RE.test(body?.id)) return sendJson(res, 400, { error: 'bad id' })
  const file = transcriptOf(body.id)
  if (!file) return sendJson(res, 404, { error: 'no such session' })
  // One line: a newline typed into Claude Code's prompt would send it early.
  const prompt = typeof body.prompt === 'string' ? body.prompt.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 2000) : ''
  const title = [...listCache.values()].flatMap((c) => c.rows).find((r) => r.id === body.id)?.title || 'The session'
  // The request goes to Hammerspoon as a file, so none of it is ever Lua source.
  mkdirSync(REQUESTS, { recursive: true, mode: 0o700 })
  const request = join(REQUESTS, `${randomBytes(8).toString('hex')}.json`)
  writeFileSync(request, JSON.stringify({ file, title, prompt }), { mode: 0o600 })
  // No stdin (runTool): with an open one, `hs -c` waits for more after its answer.
  const stdout = await runTool(HS, ['-c', `return require('ccpr').request('${request}')`], TOOL_ENV, 10000)
  // `hs` can print "-- Loading extension: …" lines before the result.
  const said = stdout.trim().split('\n').pop()
  return said === 'ok' ? sendJson(res, 200, { ok: true, title }) : sendJson(res, 502, { error: said || 'Hammerspoon said nothing' })
}

createServer(async (req, res) => {
  // Loopback only, by name too: a page on another host name that resolves here
  // (DNS rebinding) is turned away.
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
    res.writeHead(421, { 'Content-Type': 'text/plain' })
    res.end('wrong host\n')
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/idle') {
    try {
      return sendJson(res, 200, { idle: await idleSeconds() })
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }
  if (url.pathname === '/pr-sessions' || url.pathname === '/pr-sessions/send') {
    try {
      return await handlePrSessions(req, res, url)
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }
  if (url.pathname === '/review-sessions') {
    try {
      return await handleReviews(req, res, url)
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }
  // No CORS header on purpose: an ordinary page can't read session names. The
  // userscript asks through GM_xmlhttpRequest, which CORS doesn't apply to.
  if (url.pathname === '/claude-sessions') {
    const ids = [...new Set((url.searchParams.get('ids') || '').split(','))]
      .filter((id) => SESSION_ID.test(id))
      .slice(0, MAX_SESSION_IDS)
    try {
      const body = JSON.stringify(await sessionNames(ids))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(body)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`${e.message}\n`)
    }
    return
  }

  const match = /^\/pr\/(\d{1,9})$/.exec(url.pathname)
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('routes: /pr/<id>, /claude-sessions, /pr-sessions, /idle, /review-sessions (see README)\n')
    return
  }

  if (!ORG || !PROJECT) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end(`/pr/<id> needs "org" and "project" in ${CONFIG_FILE}\n`)
    return
  }
  const id = match[1]
  // Fall back to the most common repo rather than erroring — a wrong-repo page
  // is no worse than the static-template behavior this service replaces.
  const repo = (await resolveRepo(id)) || FALLBACK_REPO
  if (!repo) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`couldn't find PR ${id}'s repo (and no "fallbackRepo" in ${CONFIG_FILE})\n`)
    return
  }
  res.writeHead(302, { Location: webUrl(repo, id), 'Cache-Control': 'no-store' })
  res.end()
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`ado-companion listening on http://127.0.0.1:${PORT}\n`)
})
