// ==UserScript==
// @name         Azure DevOps Toolbox
// @namespace    https://www.seldoncortex.com/
// @version      2026-11-11.3
// @description  All-in-one Azure DevOps helpers: PR dashboard filters and new-comment previews, file-path copy buttons, branch-name copy buttons, PR and work item keyboard shortcuts, open-PR-in-VS-Code, a work item modal on PR pages, a work-on-in-Claude launcher button, the Claude sessions behind a PR, a send-to-Claude-Code button on PR comment threads, and an opt-in PR review clock.
// @author       Stan Stanislaus
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=visualstudio.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_notification
// @connect      127.0.0.1
// @downloadURL  https://raw.githubusercontent.com/Stan-Stani/userscripts/main/azureDevops/azureDevops.user.js
// @updateURL    https://raw.githubusercontent.com/Stan-Stani/userscripts/main/azureDevops/azureDevops.user.js
// ==/UserScript==

/*
 * This script consolidates three previously separate userscripts into one
 * distributable file so the whole team installs a single script that auto-updates.
 *
 * Features (each is self-contained, URL-gated, and isolated by try/catch so a
 * failure in one cannot break the others):
 *   1. PR File Path Tools  — copy buttons + hover full-path on PR file headers
 *   2. Branch Name Tools   — copy "bug/14826-title" branch names from cards / work items
 *   3. PR Hotkeys          — keyboard shortcuts for PR comment views + branch copy
 *   4. PR Dashboard Filters — hide drafts, auto-complete PRs, and conflicts
 *   5. Open PR in VS Code  — hand the PR to the AzDO Pull Requests (Multi-Project) VS Code extension
 *   6. Work Item Hotkeys   — Ctrl/Cmd+Enter saves the discussion comment, like PR comments
 *   7. Work Item Modal     — PR side-panel work items open in an on-page modal, not a navigation
 *   8. Work on in Claude   — button that hands a work item to a launcher on your machine (e.g. cc-wi)
 *   9. PR Dashboard Commenters — commenters' photos + hover previews of new comments and unresolved threads on My pull requests
 *  10. PR Claude Sessions — the PR's claude.ai session links + a resume-locally launcher in its side pane
 *  11. Send to Claude Code — a button on each PR comment thread that hands it to a local Claude Code session
 *  12. PR Review Clock  — opt-in timer for your time reviewing a PR (Tampermonkey menu → "Review clock: turn on")
 *
 * To add a feature: write a create*() factory returning
 *   { name, match(url), init?(), process?() }
 * and add it to the FEATURES array. `init` runs once on first matching page;
 * `process` runs on every DOM mutation (and must self-guard against re-processing).
 */

;(function () {
  "use strict"

  // ============================================================
  // Shared helpers
  // ============================================================
  const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 2h7a2 2 0 0 1 2 2v9h-1V4a1 1 0 0 0-1-1H4V2zm-2 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1v8h8V6H2z"/>
  </svg>`

  const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M13.854 3.146a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 9.793l6.646-6.647a.5.5 0 0 1 .708 0z"/>
  </svg>`

  function injectStyle(css) {
    const style = document.createElement("style")
    style.textContent = css
    document.head.appendChild(style)
  }

  // Identify the PR the current page (or a given PR link's path) belongs to.
  // Works for both dev.azure.com/{org}/{project}/_git/... and legacy
  // {account}.visualstudio.com/[{collection}/]{project}/_git/... — REST API and
  // PR page paths both live under the prefix that precedes "/_git/".
  function currentPrInfo(path = location.pathname) {
    const idx = path.indexOf("/_git/")
    if (idx === -1) return null
    const prefix = path.slice(0, idx)
    const rest = path.slice(idx + "/_git/".length)
    const repo = rest.split("/")[0]
    const m = rest.match(/pullrequest\/(\d+)/i)
    if (!repo || !m) return null
    return { prefix, repo, prId: m[1] }
  }

  // dev.azure.com/{org}/{project}/… or {org}.visualstudio.com/[{collection}/]{project}/…
  function orgAndProject(prefix) {
    const segments = prefix.split("/").filter(Boolean).map(decodeURIComponent)
    const org = location.hostname.toLowerCase() === "dev.azure.com" ? segments[0] : location.hostname.split(".")[0]
    return { org, project: segments[segments.length - 1] }
  }

  // The optional local service on 127.0.0.1:47811 (Stan's ado-pr-redirector; see
  // README). ADO's CSP keeps the page from calling localhost, so this goes
  // through GM_xmlhttpRequest. A POST carries JSON and X-ADO-Toolbox: 1, which a
  // web page can't send there without a CORS preflight the service never answers.
  // Rejects when the service or GM_xmlhttpRequest is missing.
  function localService(method, path, body, timeout = 4000) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("GM_xmlhttpRequest unavailable"))
      GM_xmlhttpRequest({
        method,
        url: `http://127.0.0.1:47811${path}`,
        timeout,
        headers: body ? { "Content-Type": "application/json", "X-ADO-Toolbox": "1" } : {},
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          let json = null
          try {
            json = JSON.parse(r.responseText)
          } catch {
            /* not JSON */
          }
          if (r.status !== 200) return reject(new Error((json && json.error) || `${r.status} from ${path}`))
          if (json === null) return reject(new Error(`no JSON from ${path}`))
          resolve(json)
        },
        onerror: () => reject(new Error("local service unreachable")),
        ontimeout: () => reject(new Error("local service timed out")),
      })
    })
  }

  async function fetchJson(url, body, method) {
    const response = await fetch(url, {
      method: method || (body ? "POST" : "GET"),
      credentials: "include",
      headers: body
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`${response.status} from ${url}`)
    return response.json()
  }

  function timeAgo(iso) {
    const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000)
    if (minutes < 1) return "just now"
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString()
  }

  // ">_" prompt glyph
  const TERMINAL_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
    <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3"/>
  </svg>`

  // A launcher button hands something to a program on the user's own machine.
  // The launcher is a per-browser URL template whose placeholders `fill`
  // replaces; clicking navigates to the result, so the OS opens whatever
  // handles that scheme. Nothing is stored until the user confirms: with no
  // template saved, a click opens a setup popover prefilled with
  // `defaultTemplate` and "Save & open"; right-click reopens it to change or
  // clear the template. The button gets the ">_" icon (a check mark flashes
  // on launch) plus an optional label, and the classes ado-launcher-open
  // (popover showing) and ado-launcher-sent (just launched) for styling.
  const LAUNCHER_STYLES = `
    .ado-launcher-icon { display: inline-flex; }
    .ado-launcher-popover {
      position: fixed;
      z-index: 99999;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      padding: 10px 12px;
      width: 400px;
      font-size: 12px;
      font-family: inherit;
      color: #333;
    }
    .ado-launcher-pop-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .ado-launcher-pop-hint {
      color: #666;
      margin-bottom: 8px;
    }
    .ado-launcher-pop-hint code {
      font-family: monospace;
      font-size: 11px;
    }
    .ado-launcher-pop-input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #ccc;
      border-radius: 3px;
      padding: 4px 6px;
      font-size: 11px;
      font-family: monospace;
      margin-bottom: 8px;
    }
    .ado-launcher-pop-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ado-launcher-pop-actions button {
      border: 1px solid #ccc;
      border-radius: 3px;
      background: #f5f5f5;
      padding: 3px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    .ado-launcher-pop-actions button:hover { background: #e8e8e8; }
    .ado-launcher-pop-save {
      background: #0078d4 !important;
      border-color: #0078d4 !important;
      color: #fff;
    }
    .ado-launcher-pop-save:hover { background: #106ebe !important; }
    .ado-launcher-pop-clear {
      margin-left: auto;
      border: none !important;
      background: none !important;
      color: #a4262c;
    }
  `
  let launcherStylesInjected = false

  //   storageKey       localStorage key holding the template
  //   defaultTemplate  the setup popover's prefill
  //   heading          the popover's title
  //   hint(btn)        the popover's explanation (HTML)
  //   fill(template, btn) → the URL to open, or null when the button can't launch
  //   tooltip(btn, configured) → the button's title
  function createLauncher({ storageKey, defaultTemplate, heading, hint, fill, tooltip }) {
    function template() {
      return localStorage.getItem(storageKey) || ""
    }

    function buildUrl(btn) {
      const current = template()
      return current ? fill(current, btn) : null
    }

    // Call again whenever something `fill` reads from the button changes.
    function refresh(btn) {
      const url = buildUrl(btn)
      if (url) btn.dataset.launchUrl = url
      else delete btn.dataset.launchUrl
      btn.title = tooltip(btn, Boolean(url))
    }

    function launch(btn) {
      const url = buildUrl(btn)
      if (!url) return
      // Navigating to a custom scheme hands off to the OS; the page stays put.
      // Inside the Work Item Modal's iframe, navigate the top window instead so
      // the browser's "open external app?" prompt shows where the user is looking.
      let target = window
      try {
        if (window.top && window.top.location.origin === location.origin) target = window.top
      } catch {
        // cross-origin parent: fall back to this frame
      }
      target.location.href = url
      const icon = btn.querySelector(".ado-launcher-icon")
      btn.classList.add("ado-launcher-sent")
      icon.innerHTML = CHECK_ICON
      setTimeout(() => {
        btn.classList.remove("ado-launcher-sent")
        icon.innerHTML = TERMINAL_ICON
      }, 1500)
    }

    // --- Setup popover (first click, or right-click to change) ---
    let activePopover = null
    let popoverBtn = null

    function closePopover() {
      activePopover?.remove()
      activePopover = null
      popoverBtn?.classList.remove("ado-launcher-open")
      popoverBtn = null
      document.removeEventListener("mousedown", onOutsideClick, true)
      document.removeEventListener("keydown", onEscape, true)
    }

    function onOutsideClick(e) {
      if (activePopover && !activePopover.contains(e.target) && !popoverBtn?.contains(e.target)) closePopover()
    }

    function onEscape(e) {
      if (e.key === "Escape") { e.stopPropagation(); closePopover() }
    }

    function showPopover(btn) {
      closePopover()
      const current = template()

      const pop = document.createElement("div")
      pop.className = "ado-launcher-popover"
      pop.innerHTML = `
        <div class="ado-launcher-pop-title">${heading}</div>
        <div class="ado-launcher-pop-hint">${hint(btn)}</div>
        <input class="ado-launcher-pop-input" type="text" spellcheck="false" />
        <div class="ado-launcher-pop-actions">
          <button type="button" class="ado-launcher-pop-save">Save &amp; open</button>
          <button type="button" class="ado-launcher-pop-cancel">Not now</button>
          ${current ? `<button type="button" class="ado-launcher-pop-clear" title="Forget the launcher; the button will ask again">Clear</button>` : ""}
        </div>
      `
      const input = pop.querySelector(".ado-launcher-pop-input")
      input.value = current || defaultTemplate

      function save() {
        const val = input.value.trim()
        if (!val) return
        localStorage.setItem(storageKey, val)
        refresh(btn)
        closePopover()
        launch(btn)
      }
      pop.querySelector(".ado-launcher-pop-save").addEventListener("click", save)
      pop.querySelector(".ado-launcher-pop-cancel").addEventListener("click", closePopover)
      pop.querySelector(".ado-launcher-pop-clear")?.addEventListener("click", () => {
        localStorage.removeItem(storageKey)
        refresh(btn)
        closePopover()
      })
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save() })

      // Work item dialogs (taskboard, backlog) render in a portal stacked above
      // anything on <body>, so a popover there would open hidden behind the
      // dialog. Mount it inside the dialog instead; position: fixed keeps it
      // from being clipped by the dialog's scroll container.
      const host = btn.closest('[role="dialog"]') ?? document.body
      host.appendChild(pop)
      activePopover = pop
      popoverBtn = btn
      btn.classList.add("ado-launcher-open")

      // Below the button, flipped left if it would overflow the viewport
      const rect = btn.getBoundingClientRect()
      pop.style.top = `${rect.bottom + 4}px`
      pop.style.left = `${rect.left}px`
      requestAnimationFrame(() => {
        const popRect = pop.getBoundingClientRect()
        if (popRect.right > window.innerWidth - 8) {
          pop.style.left = `${rect.right - popRect.width}px`
        }
      })

      setTimeout(() => {
        document.addEventListener("mousedown", onOutsideClick, true)
        document.addEventListener("keydown", onEscape, true)
      }, 0)
      input.select()
    }

    // Fills `btn` with the icon (and `label`) and wires it up.
    function attach(btn, label = "") {
      if (!launcherStylesInjected) {
        launcherStylesInjected = true
        injectStyle(LAUNCHER_STYLES)
      }
      btn.innerHTML = `<span class="ado-launcher-icon">${TERMINAL_ICON}</span>`
      if (label) btn.append(label)
      refresh(btn)
      btn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (template()) launch(btn)
        else showPopover(btn)
      })
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        e.stopPropagation()
        showPopover(btn)
      })
    }

    return { attach, refresh }
  }

  // ============================================================
  // Feature 1: PR File Path Tools
  // Show full file path on hover and add copy-to-clipboard buttons for file
  // paths in Azure DevOps PR comments and file diffs.
  // ============================================================
  function createFilePathTools() {
    const PROCESSED_ATTR = "data-fp-processed"
    const PREFIXES_KEY = "ado-fp-strip-prefixes"

    // --- Prefix config (array) ---
    function getPrefixes() {
      try { return JSON.parse(localStorage.getItem(PREFIXES_KEY)) || [] } catch { return [] }
    }
    function savePrefixes(list) {
      localStorage.setItem(PREFIXES_KEY, JSON.stringify(list))
    }

    // Convert a prefix pattern to a regex (supports * as a single-segment wildcard)
    function patternToRegex(pattern) {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")
      return new RegExp("^" + escaped)
    }

    // Apply the longest matching prefix → shortest result
    function trimPath(fullPath) {
      let bestLen = 0
      for (const p of getPrefixes()) {
        if (!p) continue
        if (p.includes("*")) {
          const m = fullPath.match(patternToRegex(p))
          if (m && m[0].length > bestLen) bestLen = m[0].length
        } else {
          if (fullPath.startsWith(p) && p.length > bestLen) bestLen = p.length
        }
      }
      return bestLen ? fullPath.slice(bestLen) : fullPath
    }

    function refreshAllButtonTitles() {
      document.querySelectorAll(".ado-fp-copy-btn[data-full-path]").forEach(updateBtnTitle)
    }

    function updateBtnTitle(btn) {
      const fullPath = btn.dataset.fullPath
      const suffix = btn.dataset.line ? `:${btn.dataset.line}` : ""
      const trimmed = trimPath(fullPath)
      btn.title = trimmed !== fullPath
        ? `Copy: ${trimmed}${suffix}\n(Shift+click for full path)\n(Right-click to manage prefixes)`
        : `Copy: ${fullPath}${suffix}\n(Right-click to add strip prefix)`
    }

    // --- Popover ---
    let activePopover = null

    function closePopover() {
      activePopover?.remove()
      activePopover = null
      document.removeEventListener("mousedown", onOutsideClick, true)
    }

    function onOutsideClick(e) {
      if (activePopover && !activePopover.contains(e.target)) closePopover()
    }

    function showPopover(anchorBtn, fullPath) {
      closePopover()

      const pop = document.createElement("div")
      pop.className = "ado-fp-popover"
      pop.innerHTML = `
        <div class="ado-fp-pop-title">Strip prefixes</div>
        <div class="ado-fp-pop-hint">Full: <code>${fullPath}</code></div>
        <ul class="ado-fp-pop-list"></ul>
        <div class="ado-fp-pop-add">
          <input class="ado-fp-pop-input" type="text" placeholder="e.g. /apps/admin/ or /*/*/" />
          <button class="ado-fp-pop-add-btn">Add</button>
        </div>
        <div class="ado-fp-pop-wildcard-hint">* matches any single path segment</div>
      `

      function renderList() {
        const ul = pop.querySelector(".ado-fp-pop-list")
        const prefixes = getPrefixes()
        function previewTrim(p) {
          if (!p) return null
          if (p.includes("*")) {
            const m = fullPath.match(patternToRegex(p))
            return m ? fullPath.slice(m[0].length) : null
          }
          return fullPath.startsWith(p) ? fullPath.slice(p.length) : null
        }
        ul.innerHTML = prefixes.length
          ? prefixes.map((p, i) => {
              const result = previewTrim(p)
              const preview = result !== null
                ? `<span class="ado-fp-pop-result">→ ${result}</span>`
                : `<span class="ado-fp-pop-nomatch">(no match)</span>`
              return `
              <li class="ado-fp-pop-item" data-i="${i}">
                <div class="ado-fp-pop-item-body">
                  <span class="ado-fp-pop-prefix">${p}</span>
                  ${preview}
                </div>
                <button class="ado-fp-pop-del" data-i="${i}" title="Remove">×</button>
              </li>`
            }).join("")
          : `<li class="ado-fp-pop-empty">No prefixes configured</li>`

        ul.querySelectorAll(".ado-fp-pop-del").forEach(btn => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation()
            const list = getPrefixes()
            list.splice(Number(btn.dataset.i), 1)
            savePrefixes(list)
            refreshAllButtonTitles()
            renderList()
          })
        })
      }

      renderList()

      const input = pop.querySelector(".ado-fp-pop-input")
      // Pre-fill with current path so user can trim it to the desired prefix
      input.value = fullPath

      const addBtn = pop.querySelector(".ado-fp-pop-add-btn")
      function doAdd() {
        const val = input.value.trim()
        if (!val) return
        const list = getPrefixes()
        if (!list.includes(val)) { list.push(val); savePrefixes(list) }
        refreshAllButtonTitles()
        renderList()
        input.value = ""
      }
      addBtn.addEventListener("click", doAdd)
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd() })

      document.body.appendChild(pop)
      activePopover = pop

      // Position near the anchor button
      const rect = anchorBtn.getBoundingClientRect()
      const scrollY = window.scrollY
      const scrollX = window.scrollX
      pop.style.top = `${rect.bottom + scrollY + 4}px`
      pop.style.left = `${rect.left + scrollX}px`

      // Flip left if overflowing right edge
      requestAnimationFrame(() => {
        const popRect = pop.getBoundingClientRect()
        if (popRect.right > window.innerWidth - 8) {
          pop.style.left = `${rect.right + scrollX - popRect.width}px`
        }
      })

      setTimeout(() => document.addEventListener("mousedown", onOutsideClick, true), 0)
      input.select()
    }

    function makeCopyBtn(fullPath, line = "") {
      const btn = document.createElement("button")
      btn.className = "ado-fp-copy-btn"
      btn.dataset.fullPath = fullPath
      if (line) btn.dataset.line = line
      updateBtnTitle(btn)
      btn.innerHTML = COPY_ICON

      btn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (activePopover) { closePopover(); return }
        const base = e.shiftKey ? fullPath : trimPath(fullPath)
        // Read the line at click time: for comment headers it's patched on
        // asynchronously once the PR threads API responds (see loadThreadLines).
        const ln = btn.dataset.line
        const pathToCopy = ln ? `${base}:${ln}` : base
        navigator.clipboard.writeText(pathToCopy).then(() => {
          btn.classList.add("ado-fp-copied")
          btn.innerHTML = CHECK_ICON
          setTimeout(() => {
            btn.classList.remove("ado-fp-copied")
            btn.innerHTML = COPY_ICON
          }, 1500)
        })
      })

      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        e.stopPropagation()
        showPopover(btn, fullPath)
      })

      return btn
    }

    // --- Overview tab: anchored line numbers via the PR threads API ---
    //
    // Each comment header link carries a discussionId (the thread id) but NOT the
    // anchored line: the line only exists in the diff-snippet preview, which ADO
    // lazy-loads when the thread is scrolled into view. So we can't read it from
    // the DOM when the button is created. Instead we fetch the PR threads once
    // (same-origin, with the user's session) and map discussionId -> line, then
    // patch the line onto each button as soon as the response arrives.
    const lineByDiscussion = new Map()
    let loadedPrId = null
    let loadingPrId = null

    function applyLinesToButtons() {
      document
        .querySelectorAll(".ado-fp-copy-btn[data-discussion-id]")
        .forEach((btn) => {
          if (btn.dataset.line) return
          const line = lineByDiscussion.get(btn.dataset.discussionId)
          if (line) {
            btn.dataset.line = String(line)
            updateBtnTitle(btn)
          }
        })
    }

    function loadThreadLines() {
      const info = currentPrInfo()
      if (!info) return
      if (loadedPrId === info.prId || loadingPrId === info.prId) return
      // New PR (e.g. SPA navigation): drop the previous PR's lines.
      lineByDiscussion.clear()
      loadedPrId = null
      loadingPrId = info.prId

      const api =
        `${location.origin}${info.prefix}/_apis/git/repositories/` +
        `${info.repo}/pullRequests/${info.prId}/threads?api-version=7.1-preview.1`

      fetch(api, { credentials: "include", headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !data.value) return
          for (const t of data.value) {
            const ctx = t.threadContext
            if (!ctx) continue
            const line =
              (ctx.rightFileStart && ctx.rightFileStart.line) ||
              (ctx.leftFileStart && ctx.leftFileStart.line) ||
              null
            if (line) lineByDiscussion.set(String(t.id), line)
          }
          loadedPrId = info.prId
          applyLinesToButtons()
        })
        .catch(() => {})
        .finally(() => {
          if (loadingPrId === info.prId) loadingPrId = null
        })
    }

    // --- Overview tab: comment thread file headers ---
    function processCommentFileHeaders() {
      document
        .querySelectorAll(`.comment-file-header-title:not([${PROCESSED_ATTR}])`)
        .forEach((titleRow) => {
          titleRow.setAttribute(PROCESSED_ATTR, "1")

          const link = titleRow.querySelector("a.comment-file-header-link")
          if (!link) return

          // The header link looks like ...?path=/src/foo.ts&discussionId=42 —
          // the path is here, but the anchored line is not (it's fetched async
          // by discussionId, see loadThreadLines above).
          let params = null
          try { params = new URL(link.href, location.origin).searchParams } catch {}

          const pathSpan = link.nextElementSibling
          let fullPath =
            pathSpan && pathSpan.textContent.trim().startsWith("/")
              ? pathSpan.textContent.trim()
              : ""

          if (!fullPath && params) {
            fullPath = decodeURIComponent(params.get("path") || "")
          }

          if (!fullPath) return

          link.title = fullPath
          if (pathSpan) pathSpan.title = fullPath

          const discussionId = params && params.get("discussionId")
          const known = discussionId ? lineByDiscussion.get(discussionId) : ""

          const btn = makeCopyBtn(fullPath, known ? String(known) : "")
          btn.style.alignSelf = "center"
          if (discussionId) {
            btn.dataset.discussionId = discussionId
            loadThreadLines() // self-guards; fetch runs at most once per PR
          }
          titleRow.insertBefore(btn, titleRow.lastElementChild)
        })
    }

    // --- Files tab: diff file headers ---
    function processFilesTabHeaders() {
      document
        .querySelectorAll(`.repos-summary-header:not([${PROCESSED_ATTR}])`)
        .forEach((header) => {
          header.setAttribute(PROCESSED_ATTR, "1")

          const collapseBtn = header.querySelector("button[aria-label]")
          if (!collapseBtn) return
          const label = collapseBtn.getAttribute("aria-label") || ""
          const fullPath = label.replace(/\s+Collapse$/, "").trim()
          if (!fullPath) return

          const fileNameEl = header.querySelector(".body-m.font-weight-semibold.text-ellipsis")
          if (fileNameEl) fileNameEl.title = fullPath
          const pathEl = header.querySelector(".body-s.secondary-text.text-ellipsis:not(.repos-change-summary-file-icon-container)")
          if (pathEl) pathEl.title = fullPath

          const flexRow = header.querySelector(".flex-row.flex-start.flex-grow.text-ellipsis.sticky")
          if (flexRow) {
            const actionsRow = flexRow.querySelector(".flex-row.flex-grow.justify-end")
            const btn = makeCopyBtn(fullPath)
            btn.style.alignSelf = "center"
            if (actionsRow) {
              actionsRow.insertBefore(btn, actionsRow.firstChild)
            } else {
              btn.style.marginLeft = "auto"
              flexRow.appendChild(btn)
            }
          }
        })
    }

    const STYLES = `
      .ado-fp-copy-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 2px 5px;
        border-radius: 3px;
        opacity: 0;
        color: inherit;
        flex-shrink: 0;
        transition: opacity 0.15s, background 0.15s;
        vertical-align: middle;
      }
      .comment-file-header-title:hover .ado-fp-copy-btn,
      .repos-summary-header:hover .ado-fp-copy-btn {
        opacity: 0.45;
      }
      .ado-fp-copy-btn:hover {
        opacity: 1 !important;
        background: rgba(0,0,0,0.08);
      }
      .ado-fp-copy-btn.ado-fp-copied {
        opacity: 1 !important;
        color: #107c10;
      }
      .ado-fp-popover {
        position: absolute;
        z-index: 99999;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        padding: 10px 12px;
        min-width: 320px;
        max-width: 520px;
        font-size: 12px;
        font-family: inherit;
      }
      .ado-fp-pop-title {
        font-weight: 600;
        font-size: 13px;
        margin-bottom: 6px;
      }
      .ado-fp-pop-hint {
        color: #666;
        margin-bottom: 8px;
        word-break: break-all;
      }
      .ado-fp-pop-hint code {
        font-family: monospace;
        font-size: 11px;
      }
      .ado-fp-pop-list {
        list-style: none;
        margin: 0 0 8px;
        padding: 0;
      }
      .ado-fp-pop-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 4px;
        border-radius: 3px;
      }
      .ado-fp-pop-item:hover {
        background: #f3f3f3;
      }
      .ado-fp-pop-prefix {
        font-family: monospace;
        font-size: 11px;
        word-break: break-all;
      }
      .ado-fp-pop-del {
        background: none;
        border: none;
        cursor: pointer;
        color: #999;
        font-size: 16px;
        line-height: 1;
        padding: 0 2px;
        flex-shrink: 0;
      }
      .ado-fp-pop-del:hover { color: #d00; }
      .ado-fp-pop-empty {
        color: #999;
        font-style: italic;
        padding: 2px 4px;
      }
      .ado-fp-pop-add {
        display: flex;
        gap: 6px;
      }
      .ado-fp-pop-input {
        flex: 1;
        border: 1px solid #ccc;
        border-radius: 3px;
        padding: 3px 6px;
        font-size: 11px;
        font-family: monospace;
      }
      .ado-fp-pop-add-btn {
        border: 1px solid #ccc;
        border-radius: 3px;
        padding: 3px 8px;
        cursor: pointer;
        background: #f5f5f5;
        font-size: 12px;
      }
      .ado-fp-pop-add-btn:hover { background: #e8e8e8; }
      .ado-fp-pop-wildcard-hint { color: #999; font-size: 11px; margin-top: 5px; }
      .ado-fp-pop-item-body { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .ado-fp-pop-result { font-family: monospace; font-size: 10px; color: #107c10; word-break: break-all; }
      .ado-fp-pop-nomatch { font-size: 10px; color: #999; font-style: italic; }
    `

    return {
      name: "PR File Path Tools",
      match: (url) => url.includes("/pullrequest/"),
      init() { injectStyle(STYLES) },
      process() {
        processCommentFileHeaders()
        processFilesTabHeaders()
      },
    }
  }

  // ============================================================
  // Feature 2: Branch Name from Work Item
  // Adds a copy button to sprint board cards and work item pages to copy the
  // branch name (e.g. bug/14826-title, cr/14826-title).
  // ============================================================
  function createBranchNameTools() {
    const PROCESSED_ATTR = "data-bn-processed"

    const STYLES = `
      .ado-bn-copy-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 2px 5px;
        border-radius: 3px;
        opacity: 0;
        color: inherit;
        flex-shrink: 0;
        transition: opacity 0.15s, background 0.15s;
        vertical-align: middle;
      }
      .taskboard-card:hover .ado-bn-copy-btn {
        opacity: 0.45;
      }
      .work-item-title-textfield:hover .ado-bn-copy-btn {
        opacity: 0.45;
      }
      .ado-bn-copy-btn:hover {
        opacity: 1 !important;
        background: rgba(0,0,0,0.08);
      }
      .ado-bn-copy-btn.ado-bn-copied {
        opacity: 1 !important;
        color: #107c10;
      }
      .ado-bn-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #a4262c;
        color: #fff;
        padding: 12px 20px;
        border-radius: 4px;
        font-size: 13px;
        z-index: 2147483647;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        animation: ado-bn-fade-in 0.2s;
      }
      @keyframes ado-bn-fade-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `

    function showToast(message, duration = 5000) {
      const toast = document.createElement("div")
      toast.className = "ado-bn-toast"
      toast.textContent = message
      document.body.appendChild(toast)
      setTimeout(() => toast.remove(), duration)
    }

    const TYPE_PREFIXES = {
      "bug": "bug",
      "change request": "cr",
      "user story": "us",
      "feature": "feat",
      "task": "task",
    }

    function toKebabCase(str) {
      return str
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    }

    // getBranchName can be a string (static) or a function (dynamic, e.g. reads from input)
    function makeCopyBtn(getBranchName) {
      const getter = typeof getBranchName === "function" ? getBranchName : () => getBranchName
      const btn = document.createElement("button")
      btn.className = "ado-bn-copy-btn"
      btn.title = "Copy as branch name"
      btn.innerHTML = COPY_ICON

      btn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        const branchName = getter()
        navigator.clipboard.writeText(branchName).then(() => {
          btn.title = `Copied: ${branchName}`
          btn.classList.add("ado-bn-copied")
          btn.innerHTML = CHECK_ICON
          setTimeout(() => {
            btn.title = "Copy as branch name"
            btn.classList.remove("ado-bn-copied")
            btn.innerHTML = COPY_ICON
          }, 1500)
        })
      })

      return btn
    }

    function processCards() {
      document
        .querySelectorAll(`.taskboard-card:not(.unparented-card):not([${PROCESSED_ATTR}])`)
        .forEach((card) => {
          card.setAttribute(PROCESSED_ATTR, "1")
          const typeLabel = (card.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "").trim().toLowerCase()
          const prefix = TYPE_PREFIXES[typeLabel]
          const id = card.querySelector(".font-weight-semibold.selectable-text")?.innerText?.trim()
          if (!id) return
          const titleLink = card.querySelector("a.title")
          if (!titleLink) return
          const title = toKebabCase(titleLink.innerText)
          titleLink.parentElement.appendChild(makeCopyBtn(() => {
            if (!prefix) {
              showToast(`Unknown work item type: "${typeLabel}"`)
              throw new Error(`Unknown work item type: "${typeLabel}"`)
            }
            return `${prefix}/${id}-${title}`
          }))
        })
    }

    function processWorkItemPage() {
      const titleContainer = document.querySelector(
        `.work-item-title-textfield:not([${PROCESSED_ATTR}])`
      )
      if (!titleContainer) return
      const header = document.querySelector(".work-item-form-header")
      if (!header) return
      const titleInput = titleContainer.querySelector("input")
      if (!titleInput) return

      titleContainer.setAttribute(PROCESSED_ATTR, "1")

      const pathMatch = window.location.pathname.match(/_workitems\/edit\/(\d+)/)
      const queryMatch = new URLSearchParams(window.location.search).get("workitem")
      const id = pathMatch?.[1] ?? queryMatch
      if (!id) return

      titleContainer.appendChild(
        makeCopyBtn(() => {
          const typeLabel = (header.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "").trim().toLowerCase()
          const prefix = TYPE_PREFIXES[typeLabel]
          if (!prefix) {
            showToast(`Unknown work item type: "${typeLabel}"`)
            throw new Error(`Unknown work item type: "${typeLabel}"`)
          }
          return `${prefix}/${id}-${toKebabCase(titleInput.value)}`
        })
      )
    }

    return {
      name: "Branch Name from Work Item",
      // Sprint taskboard cards, the full work item edit page, and any page where
      // a work item opens as a side panel (boards/backlogs/queries → ?workitem=NNN).
      match: (url) =>
        url.includes("/_sprints/taskboard/") ||
        url.includes("/_workitems/edit/") ||
        /[?&]workitem=\d/.test(url),
      init() { injectStyle(STYLES) },
      process() {
        processCards()
        processWorkItemPage()
      },
    }
  }

  // ============================================================
  // Feature 3: PR Hotkeys
  //   Win:  Ctrl + Right Arrow      Mac:  Ctrl + Opt + Right Arrow  : Show only active (unresolved) comments
  //   Win:  Ctrl + Left Arrow       Mac:  Ctrl + Opt + Left Arrow   : Show everything
  //   Win:  Win + ]                 Mac:  Cmd + Opt + ]             : Copy source branch name to clipboard
  //
  // Only the Mac bindings differ from the originals: plain Ctrl+Arrow is reserved
  // by macOS Mission Control (switch spaces) and plain Cmd+] is Chrome's Forward
  // nav. Windows keeps its original Ctrl+Arrow / Win+] bindings.
  // ============================================================
  function createHotkeys() {
    const isMac = /Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)

    // Modifier check for the comment-view toggle (paired with Arrow keys).
    const commentNavModifier = (event) =>
      isMac ? event.ctrlKey && event.altKey : event.ctrlKey

    // Modifier check for copy-source-branch (paired with the ] key).
    // Windows keeps its original Win+] (metaKey); only Mac changes (Cmd+] would
    // trigger Chrome's Forward nav, so it needs the extra Option).
    const branchCopyModifier = (event) =>
      isMac ? event.metaKey && event.altKey : event.metaKey

    const showOnlyActiveComments = (event) => {
      if (
        event.key === "ArrowRight" &&
        commentNavModifier(event) &&
        document.activeElement.nodeName !== "TEXTAREA" &&
        document.activeElement.nodeName !== "INPUT"
      ) {
        const nodeArr = Array.from(
          document.querySelectorAll(
            ".bolt-button, .enabled, .bolt-focus-treatment"
          )
        ).filter((x) => x.innerText && x.innerText.includes("Show everything"))
        nodeArr[0].click()
        const nodeArrTwo = Array.from(
          document.querySelectorAll("#__bolt-active_comments")
        ).filter((x) => x.innerText && x.innerText.includes("Active comments"))
        nodeArrTwo[0].click()
      }
    }

    const showAllComments = (event) => {
      if (
        event.key === "ArrowLeft" &&
        commentNavModifier(event) &&
        document.activeElement.nodeName !== "TEXTAREA" &&
        document.activeElement.nodeName !== "INPUT"
      ) {
        const nodeArr = Array.from(
          document.querySelectorAll(
            ".bolt-button, .enabled, .bolt-focus-treatment"
          )
        ).filter((x) => x.innerText && x.innerText.includes("Active comments"))
        nodeArr[0].click()

        const nodeArrTwo = Array.from(
          document.querySelectorAll("#__bolt-everything")
        ).filter((x) => x.innerText && x.innerText.includes("Show everything"))
        nodeArrTwo[0].click()
      }
    }

    const copySourceBranchName = (event) => {
      if (
        event.code === "BracketRight" &&
        branchCopyModifier(event) &&
        document.activeElement.nodeName !== "TEXTAREA" &&
        document.activeElement.nodeName !== "INPUT"
      ) {
        const node = document.querySelector(
          ".pr-header-branches > a:nth-child(1)"
        )

        if (node?.innerText) {
          navigator.clipboard.writeText(node.innerText)
          console.log("Wrote source branch to clipboard")
        } else {
          console.error("Failed to find source branch text to copy")
        }
      }
    }

    return {
      name: "PR Hotkeys",
      match: () => true, // shortcuts self-guard against the relevant PR elements
      init() {
        document.addEventListener("keyup", showOnlyActiveComments, false)
        document.addEventListener("keyup", showAllComments, false)
        document.addEventListener("keyup", copySourceBranchName, false)
      },
    }
  }

  // ============================================================
  // Feature 6: Work Item Hotkeys
  //   Ctrl/Cmd + Enter (extra modifiers ignored) : Save the discussion comment being edited
  //
  // Parity with the pull request comment editor, which submits on Ctrl/Cmd+Enter
  // and ignores any other held modifiers. The work item form has no comment-level
  // shortcut at all: its Ctrl/Cmd+Enter is a form-wide "Save & Close" registered
  // through an exact-modifier-match hotkey manager, so a chord like
  // Cmd+Ctrl+Opt+Enter does nothing there. This handler runs in the capture
  // phase and swallows the event so that form-wide binding does not also fire.
  // ============================================================
  function createWorkItemHotkeys() {
    const isWorkItemUrl = (url) =>
      url.includes("/_workitems/edit/") || /[?&]workitem=\d/.test(url)

    // Opt-in diagnostics: localStorage["ado-toolbox-debug"] = "1" on the ADO origin.
    const debugEnabled = () => {
      try { return localStorage.getItem("ado-toolbox-debug") === "1" } catch { return false }
    }
    const debug = (msg, data) => { if (debugEnabled()) console.info(`[ADO Toolbox] Work Item Hotkeys: ${msg}`, data ?? "") }

    const isSaveButton = (btn) => {
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false
      const label = ((btn.innerText ?? btn.textContent) || btn.getAttribute("aria-label") || "").trim()
      return /^save$/i.test(label)
    }

    // The comment's Save button lives near its editor, not in the form header.
    // Search outward from the editor and stop before the tab page / form root so
    // the header's work-item "Save" can never be picked up.
    function findCommentSaveButton(editor) {
      let node = editor
      while (node && node !== document.body) {
        if (node.matches(".work-item-form-page, .work-item-form")) return null
        const btn = Array.from(node.querySelectorAll("button")).find(isSaveButton)
        if (btn) return btn
        node = node.parentElement
      }
      return null
    }

    const saveComment = (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return
      const active = document.activeElement
      const editor = active?.closest?.(".comment-editor")
      debug("Ctrl/Cmd+Enter received", {
        url: location.href,
        meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey,
        activeElement: active ? `${active.tagName}.${active.className}` : null,
        inCommentEditor: !!editor,
      })
      if (!isWorkItemUrl(location.href)) return
      if (!editor) return

      const btn = findCommentSaveButton(editor)
      if (!btn) {
        debug("no enabled comment Save button found")
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      debug("clicking comment Save")
      btn.click()
    }

    return {
      name: "Work Item Hotkeys",
      match: isWorkItemUrl,
      init() {
        document.addEventListener("keydown", saveComment, true)
        debug("armed", { url: location.href, userAgent: navigator.userAgent })
      },
    }
  }

  // ============================================================
  // Feature 7: Work Item Modal
  //   On pull request pages, a plain click on a row in the "Work items" side
  //   panel opens that work item in an on-page modal instead of navigating
  //   away. Modifier-clicks and middle-clicks keep the browser's default.
  //
  // The modal hosts the work item form in a same-origin iframe with
  // `?fullScreen=true`, which ADO renders without its header and hub
  // navigation. The Toolbox runs inside that iframe as well, so the work item
  // features (branch-name copy, comment hotkey) apply there too. The side
  // panel does not refresh after the modal closes; ADO's PR page never
  // live-updates it either.
  // ============================================================
  function createWorkItemModal() {
    const PANEL_ROW = "table.linked-wit-pr-details tr"
    const WI_LINK = 'a[href*="/_workitems/edit/"]'
    const OVERLAY_CLASS = "ado-wim-overlay"

    const STYLES = `
      .${OVERLAY_CLASS} {
        position: fixed; inset: 0; z-index: 100000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.45);
      }
      .ado-wim-dialog {
        display: flex; flex-direction: column;
        width: min(96vw, 1800px); height: 94vh;
        background: var(--background-color, #fff); color: var(--text-primary-color, #201f1e);
        border-radius: 6px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      .ado-wim-header {
        display: flex; align-items: center; gap: 12px;
        padding: 6px 8px 6px 14px; flex: none;
        border-bottom: 1px solid var(--palette-neutral-10, #e0e0e0);
        font-size: 13px;
      }
      .ado-wim-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .ado-wim-open { color: var(--communication-foreground, #0078d4); text-decoration: none; white-space: nowrap; }
      .ado-wim-open:hover { text-decoration: underline; }
      .ado-wim-close {
        border: none; background: none; cursor: pointer; font-size: 20px; line-height: 1;
        padding: 4px 8px; border-radius: 4px; color: inherit;
      }
      .ado-wim-close:hover { background: var(--palette-neutral-8, #f0f0f0); }
      .ado-wim-body { position: relative; flex: 1; min-height: 0; }
      .ado-wim-body iframe { width: 100%; height: 100%; border: none; display: block; }
      .ado-wim-loading {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 14px; color: var(--text-secondary-color, #605e5c); pointer-events: none;
      }
      .ado-wim-dialog.loaded .ado-wim-loading { display: none; }
    `

    let overlay = null

    function close() {
      overlay?.remove()
      overlay = null
    }

    function open(href, title) {
      close()
      const url = new URL(href, location.origin)
      url.searchParams.set("fullScreen", "true")

      overlay = document.createElement("div")
      overlay.className = OVERLAY_CLASS
      overlay.innerHTML = `
        <div class="ado-wim-dialog" role="dialog" aria-modal="true">
          <div class="ado-wim-header">
            <span class="ado-wim-title"></span>
            <a class="ado-wim-open" target="_blank" rel="noopener">Open full page ↗</a>
            <button class="ado-wim-close" type="button" aria-label="Close" title="Close (Esc)">×</button>
          </div>
          <div class="ado-wim-body">
            <div class="ado-wim-loading">Loading work item…</div>
            <iframe title="Work item"></iframe>
          </div>
        </div>`
      const dialog = overlay.firstElementChild
      dialog.querySelector(".ado-wim-title").textContent = title
      dialog.querySelector(".ado-wim-open").href = href
      dialog.querySelector(".ado-wim-close").addEventListener("click", close)
      // Backdrop click closes; clicks inside the dialog do not.
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
      const iframe = dialog.querySelector("iframe")
      iframe.addEventListener("load", () => dialog.classList.add("loaded"))
      iframe.src = url.toString()

      document.body.appendChild(overlay)
      dialog.querySelector(".ado-wim-close").focus()
    }

    const onClick = (event) => {
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const row = event.target.closest?.(PANEL_ROW)
      if (!row) return
      // The row's own controls (e.g. the remove-link ×) keep working.
      if (event.target.closest("button")) return
      const link = row.querySelector(WI_LINK)
      if (!link) return

      // Capture phase, before ADO's row activation and the link's own handler.
      event.preventDefault()
      event.stopPropagation()
      open(link.href, (link.innerText ?? link.textContent ?? "").trim())
    }

    const onKeydown = (event) => {
      if (event.key === "Escape" && overlay) {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }

    return {
      name: "Work Item Modal",
      match: (url) => url.includes("/pullrequest/"),
      init() {
        injectStyle(STYLES)
        document.addEventListener("click", onClick, true)
        document.addEventListener("keydown", onKeydown, true)
      },
    }
  }

  // ============================================================
  // Feature 4: PR Dashboard Filters
  // Hides PR rows carrying selected Azure DevOps status pills on My pull requests.
  // ============================================================
  function createPrDashboardFilters() {
    const SETTINGS_KEY = "ado-pr-dashboard-filters"
    const CONTROL_ID = "ado-pr-filter-control"
    const RULES_ID = "ado-pr-filter-rules"
    let processScheduled = false
    const FILTERS = [
      { key: "draft", label: "Drafts", selector: ".repos-pr-list-draft-pill" },
      { key: "autoComplete", label: "Auto-complete", selector: ".repos-pr-list-auto-complete-pill" },
      { key: "conflicts", label: "Conflicts", selector: ".repos-pr-list-conflicts-pill" },
    ]
    const DEFAULT_SETTINGS = {
      draft: true,
      autoComplete: false,
      conflicts: false,
    }

    const STYLES = `
      .ado-pr-filter-control { position: relative; }
      .ado-pr-filter-button { white-space: nowrap; }
      .ado-pr-filter-menu {
        position: absolute;
        z-index: 1000;
        top: calc(100% + 4px);
        right: 0;
        min-width: 190px;
        padding: 8px 0;
        background: var(--background-color, #fff);
        border: 1px solid rgba(0, 0, 0, 0.2);
        border-radius: 2px;
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.2);
      }
      .ado-pr-filter-menu[hidden] { display: none; }
      .ado-pr-filter-option {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 0 12px;
        cursor: pointer;
        white-space: nowrap;
      }
      .ado-pr-filter-option:hover { background: rgba(0, 0, 0, 0.06); }
      .ado-pr-filter-option input { margin: 0; }
    `

    function getSettings() {
      try {
        return {
          ...DEFAULT_SETTINGS,
          ...JSON.parse(localStorage.getItem(SETTINGS_KEY)),
        }
      } catch {
        return { ...DEFAULT_SETTINGS }
      }
    }

    function saveSettings(settings) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    }

    function updateButton(button, settings) {
      const activeCount = FILTERS.filter(({ key }) => settings[key]).length
      const text = activeCount ? `Filter PRs (${activeCount})` : "Filter PRs"
      const title = activeCount
        ? `${activeCount} pull request filter${activeCount === 1 ? "" : "s"} active`
        : "Filter pull requests"
      if (button.textContent !== text) button.textContent = text
      if (button.title !== title) button.title = title
    }

    function applyFilters() {
      const settings = getSettings()
      let rules = document.getElementById(RULES_ID)
      if (!rules) {
        rules = document.createElement("style")
        rules.id = RULES_ID
        document.head.appendChild(rules)
      }
      const selectors = FILTERS
        .filter(({ key }) => settings[key])
        .map(({ selector }) => `.repos-pr-list [role="row"]:has(${selector})`)
      const css = selectors.length
        ? `${selectors.join(",\n")} { display: none !important; }`
        : ""
      if (rules.textContent !== css) rules.textContent = css

      const button = document.querySelector(`#${CONTROL_ID} .ado-pr-filter-button`)
      if (button) updateButton(button, settings)
    }

    function closeMenu(control) {
      const button = control.querySelector(".ado-pr-filter-button")
      const menu = control.querySelector(".ado-pr-filter-menu")
      menu.hidden = true
      button.setAttribute("aria-expanded", "false")
    }

    function createControl() {
      if (document.getElementById(CONTROL_ID)) return
      const commandBar = document.querySelector(
        ".hostname-header .bolt-header-commandbar"
      )
      if (!commandBar) return

      const settings = getSettings()
      const control = document.createElement("div")
      control.id = CONTROL_ID
      control.className = "ado-pr-filter-control"
      control.innerHTML = `
        <button class="ado-pr-filter-button bolt-header-command-item-button bolt-button enabled bolt-focus-treatment"
                type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false">
          Filter PRs
        </button>
        <div class="ado-pr-filter-menu" role="menu" hidden>
          ${FILTERS.map(({ key, label }) => `
            <label class="ado-pr-filter-option" role="menuitemcheckbox">
              <input type="checkbox" data-filter-key="${key}" ${settings[key] ? "checked" : ""} />
              <span>Hide ${label}</span>
            </label>
          `).join("")}
        </div>
      `

      const button = control.querySelector(".ado-pr-filter-button")
      const menu = control.querySelector(".ado-pr-filter-menu")
      updateButton(button, settings)

      button.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        menu.hidden = !menu.hidden
        button.setAttribute("aria-expanded", String(!menu.hidden))
      })

      control.querySelectorAll("input[data-filter-key]").forEach((input) => {
        input.addEventListener("change", () => {
          const nextSettings = getSettings()
          nextSettings[input.dataset.filterKey] = input.checked
          saveSettings(nextSettings)
          applyFilters()
        })
      })

      document.addEventListener("click", (event) => {
        if (!control.contains(event.target)) closeMenu(control)
      })
      control.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeMenu(control)
          button.focus()
        }
      })

      commandBar.prepend(control)
    }

    function scheduleProcess() {
      if (processScheduled) return
      processScheduled = true
      requestAnimationFrame(() => {
        processScheduled = false
        createControl()
        applyFilters()
      })
    }

    return {
      name: "PR Dashboard Filters",
      match: (url) => new URL(url).pathname.endsWith("/_pulls"),
      init() { injectStyle(STYLES) },
      process: scheduleProcess,
    }
  }

  // ============================================================
  // Feature 5: Open PR in VS Code
  // Adds an "Open in VS Code" button beside the source branch in the PR header;
  // Alt/Option+click on the branch name does the same. Both hand the PR to the
  // "AzDO Pull Requests (Multi-Project)" extension
  // (zacharychristmas.azdo-pull-requests-multiproject, Marketplace) through its
  // vscode:// deep link, which locates the workspace folder that clones the repo
  // and opens the PR description page (Checkout lives on that page).
  //
  // Deep link contract (extension >= 1.6.0):
  //   vscode://zacharychristmas.azdo-pull-requests-multiproject/open-pr
  //     ?org=<orgUrl>&project=<project>&repo=<repo>&pr=<id>[&path=<file>&line=<n>]
  //   — every value encodeURIComponent'd; the extension matches repo/project
  //   case-insensitively and falls back to an "Open on the web" prompt when the
  //   repo isn't open in the focused VS Code window.
  //
  // The URI scheme defaults to "vscode"; set localStorage
  // "ado-vscode-uri-scheme" to e.g. "vscode-insiders" to target another build.
  // ============================================================
  function createOpenInVsCode() {
    const PROCESSED_ATTR = "data-vsc-processed"
    const SCHEME_KEY = "ado-vscode-uri-scheme"
    const EXTENSION_ID = "zacharychristmas.azdo-pull-requests-multiproject"

    const VSCODE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/>
    </svg>`

    const STYLES = `
      .ado-vsc-open-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 2px 5px;
        margin: 0 2px;
        border-radius: 3px;
        opacity: 0.55;
        color: inherit;
        flex-shrink: 0;
        transition: opacity 0.15s, background 0.15s;
        vertical-align: middle;
      }
      .ado-vsc-open-btn:hover {
        opacity: 1;
        background: rgba(0,0,0,0.08);
      }
      .ado-vsc-open-btn.ado-vsc-sent {
        opacity: 1;
        color: #107c10;
      }
    `

    function uriScheme() {
      return localStorage.getItem(SCHEME_KEY) || "vscode"
    }

    // Org URL + project name from the page URL, for both hosting styles:
    //   https://dev.azure.com/{org}/{project}/_git/...            -> https://dev.azure.com/{org}
    //   https://{org}.visualstudio.com/[{collection}/]{project}/_git/... -> https://{org}.visualstudio.com
    function currentOrgAndProject(prefix) {
      const segments = prefix.split("/").filter(Boolean).map(decodeURIComponent)
      if (!segments.length) return null
      const project = segments[segments.length - 1]
      const orgUrl = location.hostname.toLowerCase() === "dev.azure.com"
        ? `${location.origin}/${encodeURIComponent(segments[0])}`
        : location.origin
      return { orgUrl, project }
    }

    function buildDeepLink() {
      const info = currentPrInfo()
      if (!info) return null
      const org = currentOrgAndProject(info.prefix)
      if (!org) return null
      const query =
        `org=${encodeURIComponent(org.orgUrl)}` +
        `&project=${encodeURIComponent(org.project)}` +
        `&repo=${encodeURIComponent(decodeURIComponent(info.repo))}` +
        `&pr=${info.prId}`
      return `${uriScheme()}://${EXTENSION_ID}/open-pr?${query}`
    }

    function openInVsCode(btn) {
      const uri = buildDeepLink()
      if (!uri) {
        console.error("[ADO Toolbox] Could not determine the pull request from the URL")
        return
      }
      // Navigating to a custom scheme hands off to the OS; the page stays put.
      location.href = uri
      if (btn) {
        btn.classList.add("ado-vsc-sent")
        btn.innerHTML = CHECK_ICON
        setTimeout(() => {
          btn.classList.remove("ado-vsc-sent")
          btn.innerHTML = VSCODE_ICON
        }, 1500)
      }
    }

    function processPrHeader() {
      const branches = document.querySelector(`.pr-header-branches:not([${PROCESSED_ATTR}])`)
      if (!branches) return
      const sourceLink = branches.querySelector("a")
      if (!sourceLink) return
      branches.setAttribute(PROCESSED_ATTR, "1")

      const btn = document.createElement("button")
      btn.className = "ado-vsc-open-btn"
      btn.type = "button"
      btn.title = "Open this pull request in VS Code\n(Alt+click the branch name does the same)"
      btn.innerHTML = VSCODE_ICON
      btn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        openInVsCode(btn)
      })
      // Land after ADO's own copy-branch-name button rather than jumping
      // ahead of it. That button is wrapped in a container div
      // (.bolt-clipboard-button) sized for exactly one icon button, so we
      // anchor on that wrapper -- the actual direct child of `branches` --
      // rather than the <button> itself, which would drop ours inside the
      // wrapper alongside it.
      const builtInCopyBtn = branches.querySelector("button")
      let anchor = sourceLink
      if (builtInCopyBtn) {
        let el = builtInCopyBtn
        while (el.parentElement && el.parentElement !== branches) {
          el = el.parentElement
        }
        anchor = el
      }
      anchor.insertAdjacentElement("afterend", btn)

      // Alt/Option+click on the branch name itself. Plain click keeps ADO's
      // navigation to the branch page.
      sourceLink.addEventListener("click", (e) => {
        if (!e.altKey) return
        e.preventDefault()
        e.stopPropagation()
        openInVsCode(btn)
      })
    }

    return {
      name: "Open PR in VS Code",
      match: (url) => url.includes("/pullrequest/"),
      init() { injectStyle(STYLES) },
      process: processPrHeader,
    }
  }

  // ============================================================
  // Feature 8: Work on in Claude
  //   A ">_" button beside the work item title that hands the item to a
  //   launcher on the user's own machine (see createLauncher), with `{id}`
  //   standing in for the work item id. The setup popover is prefilled with
  //   hammerspoon://cc-wi?id={id}. Reference setup (macOS): Hammerspoon binds
  //   hammerspoon://cc-wi and opens an iTerm2 window running `cc-wi <id>`, which
  //   starts a Claude Code session with the item's context
  //   (~/.hammerspoon/ccwi.lua on Stan's machine; see README).
  // ============================================================
  function createWorkOnInClaude() {
    const PROCESSED_ATTR = "data-ccwi-processed"

    const STYLES = `
      .ado-ccwi-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 2px 5px;
        border-radius: 3px;
        opacity: 0;
        color: inherit;
        flex-shrink: 0;
        transition: opacity 0.15s, background 0.15s;
        vertical-align: middle;
      }
      .work-item-title-textfield:hover .ado-ccwi-btn {
        opacity: 0.45;
      }
      .ado-ccwi-btn:hover, .ado-ccwi-btn.ado-launcher-open {
        opacity: 1 !important;
        background: rgba(0,0,0,0.08);
      }
      .ado-ccwi-btn.ado-launcher-sent {
        opacity: 1 !important;
        color: #107c10;
      }
    `

    const launcher = createLauncher({
      storageKey: "ado-claude-launch-url",
      defaultTemplate: "hammerspoon://cc-wi?id={id}",
      heading: "Work on this item in Claude Code",
      hint: (btn) => `
        Opens a URL on your machine with <code>{id}</code> replaced by the work item id
        (here <code>${btn.dataset.workItemId}</code>), so your OS can start a terminal or editor on it.
        Stored in this browser only.`,
      fill: (template, btn) =>
        /^\d+$/.test(btn.dataset.workItemId) ? template.replace("{id}", btn.dataset.workItemId) : null,
      tooltip: (btn, configured) =>
        `Work on #${btn.dataset.workItemId} in Claude Code\n` +
        (configured ? "(Right-click to change the launcher)" : "(Click to set up the launcher)"),
    })

    function currentWorkItemId() {
      const pathMatch = window.location.pathname.match(/_workitems\/edit\/(\d+)/)
      return pathMatch?.[1] ?? new URLSearchParams(window.location.search).get("workitem")
    }

    function processWorkItemPage() {
      const titleContainer = document.querySelector(
        `.work-item-title-textfield:not([${PROCESSED_ATTR}])`
      )
      if (!titleContainer) return
      const id = currentWorkItemId()
      if (!id || !/^\d+$/.test(id)) return
      titleContainer.setAttribute(PROCESSED_ATTR, "1")

      const btn = document.createElement("button")
      btn.className = "ado-ccwi-btn"
      btn.type = "button"
      btn.dataset.workItemId = id
      launcher.attach(btn)
      // After the Branch Name copy button, which the earlier feature appends to
      // the same container.
      titleContainer.appendChild(btn)
    }

    return {
      name: "Work on in Claude",
      // The full work item edit page and any page where a work item opens as a
      // side panel (boards/backlogs/queries → ?workitem=NNN); the Work Item
      // Modal's iframe is the edit page, so it is covered too.
      match: (url) => url.includes("/_workitems/edit/") || /[?&]workitem=\d/.test(url),
      init() { injectStyle(STYLES) },
      process: processWorkItemPage,
    }
  }

  // ============================================================
  // Feature 9: PR Dashboard Commenters
  // On My pull requests, a row whose updates say "N new comments" gets the
  // commenters' photos in front of that text, people before service
  // identities. Hovering the updates cell opens a card previewing each new
  // comment (who, when, file, text) with a link to its thread, and "Mark as
  // viewed" records a visit without opening the PR; hovering a preview shows
  // that comment in full beside the card. Hovering a comment
  // count with unresolved threads ("2 / 3") opens the same card for those
  // threads, each by its opening comment, fetched on the first hover. The
  // Filter PRs menu (Feature 4) gets a "Hide comments from" section to drop
  // people such as the AI-review build service from both, and a "Show whole
  // threads" switch (on unless unticked) for the side panel to list every
  // comment in the thread. Both stored in localStorage. Either way, each
  // preview is a thread's opening comment with its newest or latest reply
  // nested under it.
  //
  // ADO counts "new" against your last visit to the PR, which only the
  // undocumented visits API exposes (artifactVisitsBatch → lastVisitedDate;
  // a batch read, it does not record a visit). Text comments by others
  // published after that are the new ones. ADO's count is of threads, so it
  // can differ from the number of comments the card lists.
  // ============================================================
  function createPrDashboardCommenters() {
    const STACK_CLASS = "ado-pr-commenters"
    const CARD_CLASS = "ado-pr-commenters-card"
    // ADO's localized "{0} new comment(s)" string; English-only like the rest
    // of the Toolbox's text matching.
    const NEW_COMMENTS_RE = /\d+ new comments?/
    // The updates column is 190px; three 20px photos leave room for the text.
    const MAX_AVATARS = 3
    const MAX_PREVIEWS = 5
    const HIDDEN_KEY = "ado-pr-hidden-commenters"
    // Hidden until unticked: Azure Pipelines Test Service only posts test-run
    // results. Added to the hidden list once per browser (DEFAULTS_KEY records
    // which version of this list was applied), so unticking it sticks.
    const DEFAULT_HIDDEN = [{ id: "00000054-0000-8888-8000-000000000000", name: "Azure Pipelines Test Service" }]
    const DEFAULTS_KEY = "ado-pr-hidden-commenters-defaults"
    const DEFAULTS_VERSION = "1"
    const SECTION_CLASS = "ado-pr-commenter-filters"
    const PREVIEWS_CLASS = "ado-pr-preview-options"
    // ↳, before a reply nested under its thread's opening comment
    const REPLY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v5a2 2 0 0 0 2 2h7"/><path d="M10 7l3 3-3 3"/></svg>`
    // The side panel shows whole threads unless this is "0" (see showFull).
    const WHOLE_THREADS_KEY = "ado-pr-whole-threads"
    // "{PR path}|{updates text}" → Promise of new comments (newest first) or
    // null. Keying on the text refetches once ADO reports more comments.
    const commentsByKey = new Map()
    // Same for unresolved threads, keyed on "{PR path}|{comment count}".
    const threadsByKey = new Map()
    // PRs marked as viewed from a card since the page loaded. ADO's list keeps
    // saying "N new comments" until it reloads, so their cells say so instead.
    const viewedPrs = new Set()
    // Everyone loaded so far, hidden or not: id → { name, isPerson }.
    const seenCommenters = new Map()
    // Updates cell → { comments, prUrl } for its hover card.
    const cellData = new WeakMap()
    const hoverBound = new WeakSet()
    // The hover card, and the panel beside it with one comment in full.
    let card = null
    let full = null
    let showTimer = 0
    let hideTimer = 0
    let fullTimer = 0
    let hovered = null

    const STYLES = `
      .${STACK_CLASS} {
        display: inline-flex;
        flex-shrink: 0;
        margin: -2px 8px -2px 0;
      }
      .${STACK_CLASS} > * + * { margin-left: -6px; }
      /* The photos sit in the line's flex row, beside ADO's ellipsis text:
         the row must not clip them (they're taller than the text) and the
         text must still shrink to its ellipsis. */
      .repos-pr-list-updates .bolt-table-two-line-cell-item:has(> .${STACK_CLASS}) {
        overflow: visible;
        align-items: center;
      }
      .repos-pr-list-updates .bolt-table-two-line-cell-item:has(> .${STACK_CLASS}) > .text-ellipsis {
        min-width: 0;
      }
      /* Initials and "+N" come from CSS so they never join the cell's text. */
      .${STACK_CLASS}-avatar[data-label]::before { content: attr(data-label); }
      .${STACK_CLASS}-avatar {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        box-shadow: 0 0 0 2px var(--background-color, #fff);
        object-fit: cover;
        background: #605e5c;
        color: #fff;
        font-size: 9px;
        font-weight: 600;
      }
      .${STACK_CLASS}-avatar.${STACK_CLASS}-more {
        background: var(--palette-black-alpha-10, rgba(0, 0, 0, 0.1));
        color: var(--text-primary-color, rgba(0, 0, 0, 0.9));
      }
      .${CARD_CLASS} {
        position: fixed;
        z-index: 100000;
        width: 360px;
        box-sizing: border-box;
        padding: 14px 16px 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        background: var(--callout-background-color, #fff);
        color: var(--text-primary-color, rgba(0, 0, 0, 0.9));
        border-radius: 6px;
        box-shadow: 0 6.4px 14.4px rgba(0, 0, 0, 0.13), 0 1.2px 3.6px rgba(0, 0, 0, 0.11);
        font-size: 13px;
      }
      .${CARD_CLASS}[hidden] { display: none; }
      /* ADO's overflow tooltip for the truncated updates text would sit on
         top of the card. */
      body:has(.${CARD_CLASS}:not([hidden])) .bolt-tooltip-portal { display: none; }
      .${CARD_CLASS}-title { font-size: 14px; font-weight: 600; }
      .${CARD_CLASS}-item {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        column-gap: 10px;
        margin: -4px -6px;
        padding: 4px 6px;
        border-radius: 4px;
        color: inherit !important;
        text-decoration: none !important;
      }
      .${CARD_CLASS}-item:hover { background: var(--palette-black-alpha-6, rgba(0, 0, 0, 0.06)); }
      .${CARD_CLASS}-item .${STACK_CLASS}-avatar {
        width: 24px;
        height: 24px;
        box-shadow: none;
        font-size: 10px;
      }
      .${CARD_CLASS}-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .${CARD_CLASS}-meta { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .${CARD_CLASS}-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .${CARD_CLASS}-secondary { color: var(--text-secondary-color, rgba(0, 0, 0, 0.55)); white-space: nowrap; }
      .${CARD_CLASS}-file {
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: Consolas, "SF Mono", Menlo, monospace;
        font-size: 11px;
      }
      .${CARD_CLASS}-text {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 18px;
      }
      .${CARD_CLASS}-footer {
        display: flex;
        align-items: baseline;
        gap: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--palette-black-alpha-10, rgba(0, 0, 0, 0.1));
      }
      .${CARD_CLASS}-mark {
        margin-left: auto;
        padding: 0;
        border: 0;
        background: none;
        font: inherit;
        color: var(--communication-foreground, #0078d4);
        cursor: pointer;
      }
      .${CARD_CLASS}-mark:hover { text-decoration: underline; }
      .${CARD_CLASS}-mark:disabled {
        color: var(--text-secondary-color, rgba(0, 0, 0, 0.55));
        cursor: default;
        text-decoration: none;
      }
      .${STACK_CLASS}-hidden { display: none !important; }
      /* ADO draws an unread row with a bold title and a coloured bar on its left
         (bolt-list-row-marked: its first cell's left border); a row marked as
         viewed drops both. The border keeps its width so nothing shifts. */
      .${STACK_CLASS}-viewed-row .font-weight-semibold { font-weight: normal !important; }
      .${STACK_CLASS}-viewed-row .bolt-list-cell:first-child { border-left-color: transparent !important; }
      .${STACK_CLASS}-viewed {
        color: var(--text-secondary-color, rgba(0, 0, 0, 0.55));
        white-space: nowrap;
      }
      .${CARD_CLASS}-full {
        width: 480px;
        max-height: min(70vh, 600px);
        overflow-y: auto;
        /* Scrolling past the end would scroll the page, which closes it. */
        overscroll-behavior: contain;
        gap: 8px;
      }
      /* Flex items would shrink to fit and clip the comment instead of
         letting the panel scroll. */
      .${CARD_CLASS}-full > * { flex-shrink: 0; }
      .${CARD_CLASS}-full .${CARD_CLASS}-text {
        display: block;
        overflow: visible;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .${CARD_CLASS}-msg {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        column-gap: 10px;
      }
      .${CARD_CLASS}-msg .${STACK_CLASS}-avatar {
        width: 24px;
        height: 24px;
        box-shadow: none;
        font-size: 10px;
      }
      .${CARD_CLASS}-replies {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-left: 11px;
        padding-left: 12px;
        border-left: 2px solid var(--palette-black-alpha-10, rgba(0, 0, 0, 0.1));
      }
      .${CARD_CLASS}-current {
        margin: -4px -6px;
        padding: 4px 6px;
        border-radius: 4px;
        background: var(--palette-black-alpha-6, rgba(0, 0, 0, 0.06));
      }
      .${CARD_CLASS}-text-one { -webkit-line-clamp: 1; }
      .${CARD_CLASS}-sub {
        display: grid;
        grid-template-columns: 14px 18px minmax(0, 1fr);
        column-gap: 6px;
        align-items: start;
        margin-top: 4px;
        padding: 6px 8px;
        border-radius: 4px;
        background: var(--palette-black-alpha-4, rgba(0, 0, 0, 0.04));
      }
      .${CARD_CLASS}-item:hover .${CARD_CLASS}-sub { background: var(--callout-background-color, #fff); }
      .${CARD_CLASS}-sub-icon {
        display: inline-flex;
        margin-top: 2px;
        color: var(--text-secondary-color, rgba(0, 0, 0, 0.55));
      }
      .${CARD_CLASS}-sub .${STACK_CLASS}-avatar {
        width: 18px;
        height: 18px;
        box-shadow: none;
        font-size: 8px;
      }
      .${SECTION_CLASS} {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(0, 0, 0, 0.1);
      }
      .${SECTION_CLASS}-title {
        padding: 0 12px 4px;
        font-size: 12px;
        font-weight: 600;
        opacity: 0.7;
      }
    `

    // [{ id, name }]; the name lets the menu list people not on the page.
    function getHidden() {
      try { return JSON.parse(localStorage.getItem(HIDDEN_KEY)) || [] } catch { return [] }
    }
    function saveHidden(list) {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(list))
    }
    function applyDefaultHidden() {
      if (localStorage.getItem(DEFAULTS_KEY) === DEFAULTS_VERSION) return
      const list = getHidden()
      DEFAULT_HIDDEN.forEach((d) => list.some((h) => h.id === d.id) || list.push(d))
      saveHidden(list)
      localStorage.setItem(DEFAULTS_KEY, DEFAULTS_VERSION)
    }
    function wholeThreads() {
      return localStorage.getItem(WHOLE_THREADS_KEY) !== "0"
    }
    function visibleComments(comments) {
      const hiddenIds = new Set(getHidden().map((h) => h.id))
      return comments.filter((c) => !hiddenIds.has(c.authorId))
    }

    // Visits is collection-level only: it 404s under a project path.
    function collectionUrl(prefix) {
      return location.hostname.toLowerCase() === "dev.azure.com"
        ? `${location.origin}/${prefix.split("/")[1]}`
        : location.origin
    }

    // Markdown reduced to readable plain text (always shown as text, never
    // HTML). The card's two-line preview collapses the line breaks; the full
    // comment panel keeps them.
    function plainText(markdown) {
      return markdown
        .replace(/```[^\n]*\n?/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/^[ \t]*(#{1,6}|>)[ \t]*/gm, "")
        .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
        .replace(/[*`~]/g, "")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    }

    function message(c) {
      return {
        authorId: c.author.id,
        // "Core API Build Service (SteffesGroup)" → "Core API Build Service"
        name: c.author.displayName.replace(/\s*\(.*\)$/, ""),
        avatarUrl:
          (c.author._links && c.author._links.avatar && c.author._links.avatar.href) ||
          c.author.imageUrl,
        // Service identities (AI review, pipelines) have no email.
        isPerson: (c.author.uniqueName || "").includes("@"),
        published: c.publishedDate,
        text: plainText(c.content || ""),
        commentId: c.id,
      }
    }

    function preview(thread, c) {
      const ctx = thread.threadContext
      const line =
        ctx &&
        ((ctx.rightFileStart && ctx.rightFileStart.line) ||
          (ctx.leftFileStart && ctx.leftFileStart.line))
      return {
        ...message(c),
        file: ctx && ctx.filePath ? `${ctx.filePath}${line ? `:${line}` : ""}` : "",
        threadId: thread.id,
        // Every text comment in the thread, oldest first, for whole threads.
        chain: (thread.comments || []).filter((m) => m.commentType === "text" && !m.isDeleted).map(message),
      }
    }

    // The visits API's id for a PR, which needs its project and repository
    // GUIDs; the row link only has their names.
    function visitsArtifactId(pr) {
      return `vstfs:///Git/PullRequestId/${pr.repository.project.id}%2F${pr.repository.id}%2F${pr.pullRequestId}`
    }

    // Records a visit to the PR, as opening it does, so its comments stop
    // counting as new.
    async function markViewed(info) {
      const pr = await fetchJson(
        `${location.origin}${info.prefix}/_apis/git/repositories/${info.repo}/pullRequests/${info.prId}?api-version=7.1`
      )
      await fetchJson(
        `${collectionUrl(info.prefix)}/_apis/visits/artifactVisits?api-version=7.1-preview.1`,
        { artifactId: visitsArtifactId(pr) },
        "PUT"
      )
    }

    async function loadNewComments(info) {
      const api =
        `${location.origin}${info.prefix}/_apis/git/repositories/` +
        `${info.repo}/pullRequests/${info.prId}`
      // The visits artifact id needs the project and repository GUIDs; the
      // row link only has their names.
      const pr = await fetchJson(`${api}?api-version=7.1`)
      const artifactId = visitsArtifactId(pr)
      const [visits, threads] = await Promise.all([
        fetchJson(
          `${collectionUrl(info.prefix)}/_apis/visits/artifactVisitsBatch?api-version=7.1-preview.1`,
          [{ artifactId }]
        ),
        fetchJson(`${api}/threads?api-version=7.1`),
      ])
      const visit = visits.value && visits.value[0]
      const since = Date.parse(visit && visit.lastVisitedDate)
      if (Number.isNaN(since)) return null
      const me = visit.user && visit.user.id

      return threads.value
        .flatMap((thread) => (thread.comments || []).map((comment) => ({ thread, comment })))
        .filter(
          ({ comment: c }) =>
            c.commentType === "text" &&
            !c.isDeleted &&
            c.author.id !== me &&
            Date.parse(c.publishedDate) > since
        )
        .sort((a, b) => Date.parse(b.comment.publishedDate) - Date.parse(a.comment.publishedDate))
        .map(({ thread, comment }) => preview(thread, comment))
    }

    // Unresolved (active or pending) threads, most recently updated first, each
    // previewed by its opening comment.
    async function loadActiveThreads(info) {
      const threads = await fetchJson(
        `${location.origin}${info.prefix}/_apis/git/repositories/` +
          `${info.repo}/pullRequests/${info.prId}/threads?api-version=7.1`
      )
      return threads.value
        .filter((t) => !t.isDeleted && (t.status === "active" || t.status === "pending"))
        .map((t) => ({ thread: t, texts: (t.comments || []).filter((c) => c.commentType === "text" && !c.isDeleted) }))
        .filter(({ texts }) => texts.length)
        .sort((a, b) => Date.parse(b.thread.lastUpdatedDate) - Date.parse(a.thread.lastUpdatedDate))
        .map(({ thread, texts }) => ({ ...preview(thread, texts[0]), replies: texts.length - 1 }))
    }

    // One entry per author, newest first, people ahead of service identities.
    function authorsOf(comments) {
      const byId = new Map()
      comments.forEach((c) => byId.has(c.authorId) || byId.set(c.authorId, c))
      return [...byId.values()].sort((a, b) => b.isPerson - a.isPerson)
    }

    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    // The photo, or the person's initials when there is none or it fails.
    function avatar(person) {
      const initials = person.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0].toUpperCase())
        .join("")
      const fallback = el("span", `${STACK_CLASS}-avatar`)
      fallback.dataset.label = initials
      if (!person.avatarUrl) return fallback
      const img = el("img", `${STACK_CLASS}-avatar`)
      img.alt = ""
      img.src = person.avatarUrl
      img.addEventListener("error", () => img.replaceWith(fallback), { once: true })
      return img
    }

    function makeStack(authors) {
      const stack = el("span", STACK_CLASS)
      stack.setAttribute("role", "img")
      stack.setAttribute("aria-label", `New comments from ${authors.map((a) => a.name).join(", ")}`)
      const shown = authors.length > MAX_AVATARS ? authors.slice(0, MAX_AVATARS - 1) : authors
      shown.forEach((a) => stack.appendChild(avatar(a)))
      if (shown.length < authors.length) {
        const more = el("span", `${STACK_CLASS}-avatar ${STACK_CLASS}-more`)
        more.dataset.label = `+${authors.length - shown.length}`
        stack.appendChild(more)
      }
      return stack
    }

    function hideFull() {
      if (full) full.hidden = true
    }
    function scheduleFullHide() {
      clearTimeout(fullTimer)
      fullTimer = setTimeout(hideFull, 150)
    }
    function hideCard() {
      clearTimeout(showTimer)
      if (card) card.hidden = true
      hideFull()
    }
    function scheduleHide() {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(hideCard, 150)
    }

    function getCard() {
      if (card) return card
      card = el("div", CARD_CLASS)
      card.hidden = true
      card.addEventListener("mouseenter", () => clearTimeout(hideTimer))
      card.addEventListener("mouseleave", scheduleHide)
      full = el("div", `${CARD_CLASS} ${CARD_CLASS}-full`)
      full.hidden = true
      full.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer)
        clearTimeout(fullTimer)
      })
      full.addEventListener("mouseleave", () => {
        scheduleHide()
        scheduleFullHide()
      })
      document.body.append(card, full)
      // Fixed-position, so any page scroll would leave them behind; the full
      // comment panel scrolls itself.
      document.addEventListener("scroll", (e) => e.target !== full && hideCard(), true)
      return card
    }

    // The whole comment beside the card (left of it, else right), level with
    // the hovered preview, so the card never reflows under the pointer.
    // The preview in full: with whole threads on, every comment in its thread;
    // otherwise just the comment and the reply nested under it, if any.
    function showFull(item, c, sub) {
      const whole = wholeThreads()
      const chain = whole ? shownChain(c.chain) : sub ? [c, sub] : []
      const parts = []
      if (chain.length > 1) {
        if (whole) parts.push(el("div", `${CARD_CLASS}-name`, `Thread · ${chain.length} comments`))
        if (c.file) parts.push(el("div", `${CARD_CLASS}-secondary ${CARD_CLASS}-file`, c.file))
        const replies = el("div", `${CARD_CLASS}-replies`)
        chain.forEach((m, i) => {
          // The reply the preview nested gets marked, so it stands out in its thread.
          const current = whole && sub && m.commentId === sub.commentId
          const msg = el("div", `${CARD_CLASS}-msg${current ? ` ${CARD_CLASS}-current` : ""}`)
          const meta = el("div", `${CARD_CLASS}-meta`)
          meta.append(el("span", `${CARD_CLASS}-name`, m.name), el("span", `${CARD_CLASS}-secondary`, timeAgo(m.published)))
          const body = el("div", `${CARD_CLASS}-body`)
          body.append(meta, el("div", `${CARD_CLASS}-text`, m.text))
          msg.append(avatar(m), body)
          if (i === 0) parts.push(msg)
          else replies.append(msg)
        })
        parts.push(replies)
      } else {
        const meta = el("div", `${CARD_CLASS}-meta`)
        meta.append(el("span", `${CARD_CLASS}-name`, c.name), el("span", `${CARD_CLASS}-secondary`, timeAgo(c.published)))
        parts.push(meta)
        if (c.file) parts.push(el("div", `${CARD_CLASS}-secondary ${CARD_CLASS}-file`, c.file))
        parts.push(el("div", `${CARD_CLASS}-text`, c.text))
      }
      full.replaceChildren(...parts)
      full.scrollTop = 0
      full.hidden = false

      const cardRect = card.getBoundingClientRect()
      const itemRect = item.getBoundingClientRect()
      const { offsetWidth: width, offsetHeight: height } = full
      const leftOfCard = cardRect.left - width - 8
      full.style.left = `${leftOfCard >= 8 ? leftOfCard : Math.min(cardRect.right + 8, innerWidth - width - 8)}px`
      full.style.top = `${Math.max(8, Math.min(itemRect.top - 10, innerHeight - height - 8))}px`
    }

    // A thread as shown: its opening comment always, as context, even from
    // someone hidden; the rest only from people who aren't.
    function shownChain(chain) {
      return chain.length ? [chain[0], ...visibleComments(chain.slice(1))] : []
    }

    // One preview per thread: its opening comment with the reply that matters
    // nested under it, the latest reply of an unresolved thread or the newest
    // new comment of a thread. A thread whose comments are all from hidden
    // people is left out. `comments` are newest first, so a thread's first one
    // is its newest.
    function threadEntries(comments, threads) {
      const byThread = new Map()
      for (const c of threads ? comments : visibleComments(comments)) {
        if (byThread.has(c.threadId)) continue
        const visible = visibleComments(c.chain)
        if (!visible.length) continue
        const opening = c.chain[0] || c
        const sub = threads ? visible[visible.length - 1] : c
        byThread.set(c.threadId, {
          head: { ...opening, file: c.file, threadId: c.threadId, chain: c.chain, replies: c.chain.length - 1 },
          sub: sub && sub.commentId !== opening.commentId ? sub : null,
          label: threads ? "latest" : "new",
        })
      }
      return [...byThread.values()]
    }

    function subComment(m, label) {
      const box = el("div", `${CARD_CLASS}-sub`)
      const icon = el("span", `${CARD_CLASS}-sub-icon`)
      icon.innerHTML = REPLY_ICON
      const meta = el("div", `${CARD_CLASS}-meta`)
      meta.append(el("span", `${CARD_CLASS}-name`, m.name), el("span", `${CARD_CLASS}-secondary`, `${timeAgo(m.published)} · ${label}`))
      const body = el("div", `${CARD_CLASS}-body`)
      body.append(meta, el("div", `${CARD_CLASS}-text`, m.text))
      box.append(icon, avatar(m), body)
      return box
    }

    function showCard(cell) {
      const data = cellData.get(cell)
      const entries = data && data.comments ? threadEntries(data.comments, data.threads) : []
      if (!entries.length || !cell.isConnected) return
      const box = getCard()

      const items = entries.slice(0, MAX_PREVIEWS).map(({ head: c, sub, label }) => {
        const item = el("a", `${CARD_CLASS}-item`)
        const url = new URL(data.prUrl)
        url.searchParams.set("discussionId", c.threadId)
        item.href = url.href
        const meta = el("div", `${CARD_CLASS}-meta`)
        const replies = c.replies ? ` · ${c.replies} ${c.replies === 1 ? "reply" : "replies"}` : ""
        meta.append(el("span", `${CARD_CLASS}-name`, c.name), el("span", `${CARD_CLASS}-secondary`, timeAgo(c.published) + replies))
        const body = el("div", `${CARD_CLASS}-body`)
        body.append(meta)
        if (c.file) body.append(el("div", `${CARD_CLASS}-secondary ${CARD_CLASS}-file`, c.file))
        body.append(el("div", `${CARD_CLASS}-text${sub ? ` ${CARD_CLASS}-text-one` : ""}`, c.text))
        if (sub) body.append(subComment(sub, label))
        item.append(avatar(c), body)
        item.addEventListener("mouseenter", () => {
          clearTimeout(fullTimer)
          showFull(item, c, sub)
        })
        item.addEventListener("mouseleave", scheduleFullHide)
        return item
      })
      const footer = el("div", `${CARD_CLASS}-footer`)
      const open = el("a", "", "Open pull request")
      open.href = data.prUrl
      footer.append(open)
      if (entries.length > MAX_PREVIEWS) {
        footer.append(el("span", `${CARD_CLASS}-secondary`, `+${entries.length - MAX_PREVIEWS} more`))
      }
      if (data.markViewed) {
        const mark = el("button", `${CARD_CLASS}-mark`, "Mark as viewed")
        mark.type = "button"
        mark.addEventListener("click", async () => {
          mark.disabled = true
          mark.textContent = "Marking…"
          try {
            await data.markViewed()
            hideCard()
          } catch (e) {
            console.error("[ADO Toolbox] Could not mark the pull request as viewed:", e)
            mark.disabled = false
            mark.textContent = "Couldn't mark it; retry"
          }
        })
        footer.append(mark)
      }
      box.replaceChildren(el("div", `${CARD_CLASS}-title`, data.title), ...items, footer)
      box.hidden = false

      // Below the cell, right-aligned with it; above it when there's no room.
      const rect = cell.getBoundingClientRect()
      const { offsetWidth: width, offsetHeight: height } = box
      const below = rect.bottom + 4
      box.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`
      box.style.top = `${below + height > innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below}px`
    }

    // `load`, when given, supplies the cell's card data on each hover (it
    // caches its own fetches).
    function bindHover(cell, load) {
      if (hoverBound.has(cell)) return
      hoverBound.add(cell)
      cell.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer)
        clearTimeout(showTimer)
        hovered = cell
        showTimer = setTimeout(async () => {
          if (load) cellData.set(cell, await load())
          if (hovered === cell) showCard(cell)
        }, 250)
      })
      cell.addEventListener("mouseleave", () => {
        hovered = null
        clearTimeout(showTimer)
        scheduleHide()
      })
    }

    function onHiddenToggle(id, name, hide) {
      const list = getHidden().filter((h) => h.id !== id)
      if (hide) list.push({ id, name })
      saveHidden(list)
      document.querySelectorAll(`.${STACK_CLASS}`).forEach((stack) => stack.remove())
      hideCard()
      processUpdatesCells()
    }

    // Appended to Feature 4's menu; rebuilt only when the set of people
    // changes, so toggling a checkbox doesn't redraw under the pointer.
    function renderPreviewSection(menu) {
      if (menu.querySelector(`.${PREVIEWS_CLASS}`)) return
      const label = el("label", "ado-pr-filter-option")
      label.setAttribute("role", "menuitemcheckbox")
      const input = el("input")
      input.type = "checkbox"
      input.checked = wholeThreads()
      input.addEventListener("change", () => {
        localStorage.setItem(WHOLE_THREADS_KEY, input.checked ? "1" : "0")
        hideCard()
      })
      label.append(input, el("span", "", "Show whole threads"))
      const section = el("div", `${SECTION_CLASS} ${PREVIEWS_CLASS}`)
      section.append(el("div", `${SECTION_CLASS}-title`, "Previews"), label)
      // Above "Hide comments from", which comes and goes with the people loaded.
      menu.insertBefore(section, menu.querySelector(`.${SECTION_CLASS}`))
    }

    function renderFilterSection() {
      const menu = document.querySelector("#ado-pr-filter-control .ado-pr-filter-menu")
      if (!menu) return
      renderPreviewSection(menu)
      const hidden = getHidden()
      const hiddenIds = new Set(hidden.map((h) => h.id))
      const people = new Map(seenCommenters)
      hidden.forEach((h) => people.has(h.id) || people.set(h.id, { name: h.name, isPerson: true }))

      let section = menu.querySelector(`.${SECTION_CLASS}:not(.${PREVIEWS_CLASS})`)
      const signature = [...people.keys()].sort().join(",")
      if (section && section.dataset.signature === signature) return
      if (!people.size) {
        section?.remove()
        return
      }
      if (!section) {
        section = el("div", SECTION_CLASS)
        menu.appendChild(section)
      }
      section.dataset.signature = signature

      const options = [...people]
        .sort(([, a], [, b]) => b.isPerson - a.isPerson || a.name.localeCompare(b.name))
        .map(([id, { name }]) => {
          const label = el("label", "ado-pr-filter-option")
          label.setAttribute("role", "menuitemcheckbox")
          const input = el("input")
          input.type = "checkbox"
          input.checked = hiddenIds.has(id)
          input.addEventListener("change", () => onHiddenToggle(id, name, input.checked))
          label.append(input, el("span", "", name))
          return label
        })
      section.replaceChildren(el("div", `${SECTION_CLASS}-title`, "Hide comments from"), ...options)
    }

    function findNewCommentsText(cell) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (NEW_COMMENTS_RE.test(node.nodeValue)) return node
      }
      return null
    }

    // Rows are <a role="row" href=".../pullrequest/N">; keep a fallback for a
    // title link in case ADO moves the href off the row.
    function rowPr(cell) {
      const row = cell.closest('[role="row"]')
      const link = row && (row.matches("a[href]") ? row : row.querySelector('a[href*="/pullrequest/"]'))
      const info = link && currentPrInfo(new URL(link.href, location.origin).pathname)
      return info ? { info, prUrl: link.href } : null
    }

    function noteCommenters(comments) {
      comments.forEach((c) => {
        if (!seenCommenters.has(c.authorId)) seenCommenters.set(c.authorId, { name: c.name, isPerson: c.isPerson })
      })
      renderFilterSection()
    }

    // The comment-count cell ("2 / 3": unresolved / all threads) previews the
    // unresolved threads on hover; nothing loads until the first hover.
    function processCommentCounts() {
      document.querySelectorAll(".repos-pr-list-comment-count.has-active-comments").forEach((count) => {
        const group = count.closest('[role="group"]') || count
        const pr = !hoverBound.has(group) && rowPr(group)
        if (!pr) return
        bindHover(group, async () => {
          // Keyed on the count, so a new or resolved thread refetches.
          const key = `${pr.info.prefix}/${pr.info.repo}/${pr.info.prId}|${count.textContent}`
          if (!threadsByKey.has(key)) {
            threadsByKey.set(
              key,
              loadActiveThreads(pr.info).catch((e) => {
                console.error(`[ADO Toolbox] Could not load unresolved threads for PR ${pr.info.prId}:`, e)
                return null
              })
            )
          }
          const comments = await threadsByKey.get(key)
          if (!comments) return null
          noteCommenters(comments)
          return { comments, prUrl: pr.prUrl, title: "Unresolved threads", threads: true }
        })
      })
    }

    // ADO's "N new comments" line, swapped for a note once marked as viewed, and
    // the row drawn as read.
    function showViewed(textNode) {
      const line = textNode.parentElement
      line.classList.add(`${STACK_CLASS}-hidden`)
      if (!line.parentElement.querySelector(`.${STACK_CLASS}-viewed`)) {
        line.parentElement.insertBefore(el("span", `${STACK_CLASS}-viewed`, "Marked as viewed"), line)
      }
      line.closest('[role="row"]')?.classList.add(`${STACK_CLASS}-viewed-row`)
    }

    function processUpdatesCells() {
      // The menu is created on Feature 4's own schedule; cheap no-op otherwise.
      renderFilterSection()
      processCommentCounts()
      document.querySelectorAll(".repos-pr-list-updates").forEach((cell) => {
        const textNode = findNewCommentsText(cell)
        // The photos sit beside ADO's text, so they outlive a change to it
        // ("3 new comments" → "4 new comments"); rebuild them when it moves on.
        const existing = cell.querySelector(`.${STACK_CLASS}`)
        if (existing) {
          if (textNode && existing.dataset.text === textNode.nodeValue) return
          existing.remove()
        }
        if (!textNode) return
        const pr = rowPr(cell)
        if (!pr) return
        const { info } = pr
        if (viewedPrs.has(pr.prUrl)) {
          showViewed(textNode)
          return
        }

        const key = `${info.prefix}/${info.repo}/${info.prId}|${textNode.nodeValue}`
        if (!commentsByKey.has(key)) {
          commentsByKey.set(
            key,
            loadNewComments(info).catch((e) => {
              console.error(`[ADO Toolbox] Could not load new comments for PR ${info.prId}:`, e)
              return null
            })
          )
        }
        commentsByKey.get(key).then((comments) => {
          if (!comments) return
          noteCommenters(comments)
          const visible = visibleComments(comments)
          // ADO's ellipsis div, inside the first line's flex row.
          const line = textNode.parentElement
          if (!visible.length || !textNode.isConnected || !line.parentElement) return
          if (cell.querySelector(`.${STACK_CLASS}`)) return
          const stack = makeStack(authorsOf(visible))
          stack.dataset.text = textNode.nodeValue
          line.parentElement.insertBefore(stack, line)
          cellData.set(cell, {
            comments,
            prUrl: pr.prUrl,
            title: "New since your last visit",
            markViewed: async () => {
              await markViewed(info)
              viewedPrs.add(pr.prUrl)
              cellData.delete(cell)
              cell.querySelector(`.${STACK_CLASS}`)?.remove()
              processUpdatesCells()
            },
          })
          bindHover(cell)
        })
      })
    }

    return {
      name: "PR Dashboard Commenters",
      match: (url) => new URL(url).pathname.endsWith("/_pulls"),
      init() {
        injectStyle(STYLES)
        applyDefaultHidden()
      },
      process: processUpdatesCells,
    }
  }

  // ============================================================
  // Feature 10: PR Claude Sessions
  // A "Claude sessions" section in the PR overview's side pane listing the
  // claude.ai sessions that the PR description and the commits'
  // "Claude-Session:" trailers link to. Claude Code writes those links only
  // while a session runs with Remote Control, and they open only for the
  // session's owner. "Resume locally" covers the rest: a launcher (see
  // createLauncher) with {id}, {repo} and {branch} for the PR, prefilled with
  // hammerspoon://cc-pr?id={id}&branch={branch}. azureDevops/cc-pr is the
  // reference script that finds the PR's local sessions and resumes one.
  //
  // ADO's PR-commits API cuts each message down to its subject, so every
  // commit's full message is fetched once. Commits never change, so the
  // sessions each one links to are cached in localStorage.
  //
  // Rows are labelled with each session's latest commit, or with its name on
  // this machine when a local service supplies one (see localSessionNames).
  // ============================================================
  function createPrClaudeSessions() {
    const SECTION_CLASS = "ado-claude-sessions"
    const LOCAL = "ado-local-sessions"
    const CACHE_KEY = "ado-claude-session-commits"
    // Commit id → linked sessions, ~60 bytes each; the oldest go first.
    const CACHE_MAX = 5000
    const FETCH_CONCURRENCY = 4
    const SESSION_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g
    const NAMES_URL = "http://127.0.0.1:47811/claude-sessions"
    // "{prefix}/{repo}/{prId}" → Promise of { sessions, branch }
    const loads = new Map()

    const STYLES = `
      .${SECTION_CLASS}-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .${SECTION_CLASS}-head .bolt-header-title { flex-grow: 1; }
      .${SECTION_CLASS}-resume {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: transparent;
        border: none;
        border-radius: 3px;
        padding: 2px 6px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        color: var(--text-secondary-color, rgba(0, 0, 0, 0.55));
      }
      .${SECTION_CLASS}-resume:hover, .${SECTION_CLASS}-resume.ado-launcher-open {
        background: var(--palette-black-alpha-6, rgba(0, 0, 0, 0.06));
        color: var(--text-primary-color, rgba(0, 0, 0, 0.9));
      }
      .${SECTION_CLASS}-resume.ado-launcher-sent { color: #107c10; }
      .${SECTION_CLASS}-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .${SECTION_CLASS}-list li + li { margin-top: 8px; }
      .${SECTION_CLASS}-list a {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--communication-foreground, #0078d4);
        text-decoration: none;
      }
      .${SECTION_CLASS}-list a:hover { text-decoration: underline; }
      .${SECTION_CLASS}-meta, .${SECTION_CLASS}-note {
        font-size: 12px;
        color: var(--text-secondary-color, rgba(0, 0, 0, 0.55));
      }
      .${LOCAL} { margin-bottom: 24px; }
      .${LOCAL}-row { display: flex; align-items: center; gap: 4px; }
      .${LOCAL}-open {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        border: 0;
        background: none;
        padding: 0;
        font: inherit;
        color: var(--communication-foreground, #0078d4);
        cursor: pointer;
      }
      .${LOCAL}-open:hover { text-decoration: underline; }
      .${LOCAL}-ask, .${LOCAL}-more {
        border: 0;
        background: none;
        border-radius: 3px;
        cursor: pointer;
        color: var(--text-secondary-color, rgba(0, 0, 0, 0.55));
        font: inherit;
        font-size: 12px;
      }
      .${LOCAL}-ask { display: inline-flex; padding: 4px; flex-shrink: 0; }
      .${LOCAL}-more { padding: 2px 0; margin-top: 8px; }
      .${LOCAL}-ask:hover, .${LOCAL}-ask[aria-expanded="true"], .${LOCAL}-more:hover {
        background: var(--palette-black-alpha-6, rgba(0, 0, 0, 0.06));
        color: var(--text-primary-color, rgba(0, 0, 0, 0.9));
      }
      .${LOCAL}-status { color: var(--text-primary-color, rgba(0, 0, 0, 0.9)); }
      .${LOCAL}-composer { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
      .${LOCAL}-composer[hidden] { display: none; }
      .${LOCAL}-composer input {
        font: inherit;
        font-size: 13px;
        padding: 5px 8px;
        border: 1px solid var(--palette-black-alpha-20, rgba(0, 0, 0, 0.2));
        border-radius: 3px;
        background: var(--background-color, #fff);
        color: inherit;
        min-width: 0;
      }
      .${LOCAL}-actions { display: flex; gap: 6px; align-items: center; }
      .${LOCAL}-chip, .${LOCAL}-send {
        font: inherit;
        font-size: 12px;
        padding: 3px 10px;
        border-radius: 3px;
        cursor: pointer;
        border: 1px solid var(--palette-black-alpha-20, rgba(0, 0, 0, 0.2));
        background: transparent;
        color: inherit;
      }
      .${LOCAL}-send { margin-left: auto; border-color: #0078d4; background: #0078d4; color: #fff; font-weight: 600; }
      .${LOCAL}-chip:hover { background: var(--palette-black-alpha-6, rgba(0, 0, 0, 0.06)); }
    `

    const launcher = createLauncher({
      storageKey: "ado-claude-pr-launch-url",
      defaultTemplate: "hammerspoon://cc-pr?id={id}&branch={branch}",
      heading: "Resume this PR's Claude Code session",
      hint: (btn) => `
        Opens a URL on your machine with <code>{id}</code>, <code>{repo}</code> and
        <code>{branch}</code> filled in for this pull request (here <code>${btn.dataset.prId}</code>),
        so a script there can find the Claude Code sessions that worked on it and resume one
        (see <code>azureDevops/cc-pr</code> in the Toolbox repo). Stored in this browser only.`,
      fill: (template, btn) =>
        template
          .replaceAll("{id}", encodeURIComponent(btn.dataset.prId))
          .replaceAll("{repo}", encodeURIComponent(btn.dataset.repo))
          .replaceAll("{branch}", encodeURIComponent(btn.dataset.branch)),
      tooltip: (btn, configured) =>
        `Resume a local Claude Code session on PR ${btn.dataset.prId}\n` +
        (configured ? "(Right-click to change the launcher)" : "(Click to set up the launcher)"),
    })

    function readCache() {
      try {
        return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}
      } catch {
        return {}
      }
    }

    function writeCache(cache) {
      const ids = Object.keys(cache)
      ids.slice(0, Math.max(0, ids.length - CACHE_MAX)).forEach((id) => delete cache[id])
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
      } catch {
        // full or blocked storage: the next visit fetches again
      }
    }

    async function forEachLimited(items, limit, fn) {
      let next = 0
      const worker = async () => {
        while (next < items.length) await fn(items[next++])
      }
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    }

    // The sessions' names on this machine, { "session_…": { name } }, from an
    // optional local service that reads Claude Code's transcripts (Stan's
    // ado-pr-redirector; see README). ADO's CSP keeps the page from calling
    // localhost, so this goes through GM_xmlhttpRequest. With no service, or no
    // GM_xmlhttpRequest, it's {} and rows keep their commit labels.
    function localSessionNames(ids) {
      if (typeof GM_xmlhttpRequest !== "function" || !ids.length) return Promise.resolve({})
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `${NAMES_URL}?ids=${ids.join(",")}`,
          timeout: 3000,
          onload: (r) => {
            try {
              resolve(r.status === 200 ? JSON.parse(r.responseText) : {})
            } catch {
              resolve({})
            }
          },
          onerror: () => resolve({}),
          ontimeout: () => resolve({}),
        })
      })
    }

    async function loadSessions(info) {
      const api = `${location.origin}${info.prefix}/_apis/git/repositories/${info.repo}`
      const [pr, commits] = await Promise.all([
        fetchJson(`${api}/pullRequests/${info.prId}?api-version=7.1`),
        fetchJson(`${api}/pullRequests/${info.prId}/commits?$top=500&api-version=7.1`),
      ])
      const cache = readCache()
      try {
        await forEachLimited(
          commits.value.filter((c) => !cache[c.commitId]),
          FETCH_CONCURRENCY,
          async (c) => {
            const full = await fetchJson(`${api}/commits/${c.commitId}?api-version=7.1`)
            cache[c.commitId] = [...new Set(full.comment.match(SESSION_RE))]
          }
        )
      } finally {
        writeCache(cache)
      }

      const byUrl = new Map()
      const session = (url) =>
        byUrl.get(url) ?? byUrl.set(url, { url, commits: [], wrotePr: false }).get(url)
      for (const url of (pr.description || "").match(SESSION_RE) || []) session(url).wrotePr = true
      for (const c of commits.value) for (const url of cache[c.commitId] || []) session(url).commits.push(c)

      const sessions = [...byUrl.values()].map((s) => {
        const latest = s.commits.reduce(
          (a, c) => (!a || Date.parse(c.author.date) > Date.parse(a.author.date) ? c : a),
          null
        )
        return {
          ...s,
          label: latest ? latest.comment.split("\n")[0] : pr.title,
          when: latest ? latest.author.date : pr.creationDate,
        }
      })
      sessions.sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
      const names = await localSessionNames(sessions.map((s) => s.url.split("/").pop()))
      for (const s of sessions) {
        const local = names[s.url.split("/").pop()]
        s.name = local?.name
        s.localId = local?.sessionId
      }
      return { sessions, branch: pr.sourceRefName.replace(/^refs\/heads\//, "") }
    }

    // --- Local sessions: this machine's Claude Code sessions on the PR, from the
    // local service's GET /pr-sessions (cc-pr --list), above the claude.ai links.
    // Each opens in your agents view, or takes a request typed here, through
    // POST /pr-sessions/send and Hammerspoon (see README). No service: no section.
    const UPDATE_FROM_MAIN = "Update this PR's branch from main and push it."
    const localLoads = new Map() // PR key → Promise of rows
    const noLocal = new Set() // PR keys the local service didn't answer for (until reload)

    function h(tag, attrs, ...kids) {
      const node = document.createElement(tag)
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue
        if (k === "class") node.className = v
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
        else node.setAttribute(k, v === true ? "" : String(v))
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
      return node
    }

    const STATE = (live) =>
      live === "background busy" ? "working" : live === "background idle" ? "idle"
        : live.startsWith("background") ? "running" : live === "interactive" ? "open in a terminal" : "stopped"

    async function sendTo(row, prompt, status) {
      status.textContent = prompt ? "Sending…" : "Opening…"
      try {
        await localService("POST", "/pr-sessions/send", { id: row.id, prompt }, 15000)
        const done = prompt ? "Sent. It opens in your agents view." : "Opening in your agents view."
        status.textContent = done
        // A success note goes after a few seconds; an error stays until the next try.
        setTimeout(() => status.textContent === done && (status.textContent = ""), 4000)
        return true
      } catch (e) {
        status.textContent = `Couldn't: ${e.message}`
        return false
      }
    }

    // `pr` ("PR !12309 (CoreAPI)") leads every request, so the session knows which PR it's about.
    function localRow(row, commits, pr) {
      const status = h("span", { class: `${LOCAL}-status`, role: "status" })
      const input = h("input", { type: "text", maxlength: "2000", placeholder: "Ask this session…", "aria-label": `Request for ${row.title}` })
      const send = async () => {
        const prompt = input.value.trim()
        if (!prompt) return input.focus()
        if (await sendTo(row, `${pr}: ${prompt}`, status)) input.value = ""
      }
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault()
          send()
        }
      })
      const composer = h("div", { class: `${LOCAL}-composer`, hidden: true },
        input,
        h("div", { class: `${LOCAL}-actions` },
          // One click sends it; disabled while it goes so a double click can't send twice.
          h("button", { type: "button", class: `${LOCAL}-chip`, title: UPDATE_FROM_MAIN, onclick: async (e) => {
            const chip = e.currentTarget
            chip.disabled = true
            await sendTo(row, `${pr}: ${UPDATE_FROM_MAIN}`, status)
            chip.disabled = false
          } }, "Update from main"),
          h("button", { type: "button", class: `${LOCAL}-send`, onclick: send }, "Send")))
      const toggle = h("button", { type: "button", class: `${LOCAL}-ask`, "aria-label": `Send a request to ${row.title}`, title: "Send a request to this session",
        "aria-expanded": "false", onclick: () => {
          composer.hidden = !composer.hidden
          toggle.setAttribute("aria-expanded", String(!composer.hidden))
          if (!composer.hidden) input.focus()
        } })
      toggle.innerHTML = TERMINAL_ICON
      const meta = [STATE(row.live), commits && `made ${commits} commit${commits === 1 ? "" : "s"}`, row.folder, row.mtime && timeAgo(new Date(row.mtime).toISOString())]
      return h("li", null,
        h("div", { class: `${LOCAL}-row` },
          h("button", { type: "button", class: `${LOCAL}-open`, title: `${row.title}\nOpen in your agents view`, onclick: () => sendTo(row, "", status) }, row.title || "Untitled session"),
          toggle),
        h("div", { class: `${SECTION_CLASS}-meta` }, meta.filter(Boolean).join(" · "), " ", status),
        composer)
    }

    function renderLocal(body, rows, commitsBy, pr) {
      if (!rows.length) return body.replaceChildren(note("No sessions on this machine mention this PR."))
      const own = rows.filter((r) => r.related || commitsBy.has(r.id))
      const others = rows.filter((r) => !own.includes(r))
      const list = (items) => h("ul", { class: `${SECTION_CLASS}-list` }, items.map((r) => localRow(r, commitsBy.get(r.id) || 0, pr)))
      const more = others.length && list(others)
      if (more) more.hidden = true
      const reveal = others.length && h("button", { type: "button", class: `${LOCAL}-more`, "aria-expanded": "false", onclick: (e) => {
        more.hidden = !more.hidden
        e.currentTarget.setAttribute("aria-expanded", String(!more.hidden))
        e.currentTarget.textContent = more.hidden ? `${others.length} more mention it` : "Show fewer"
      } }, `${others.length} more mention it`)
      body.replaceChildren(...[own.length ? list(own) : note("None named after this PR or behind its commits."), reveal, more].filter(Boolean))
    }

    function addLocalSection(pane, info, key, before) {
      const section = h("div", { class: `${LOCAL} flex-column rhythm-vertical-8`, "data-pr": key },
        h("div", { class: `${SECTION_CLASS}-head` },
          h("div", { "aria-level": "2", class: "bolt-header-title body-xl m", role: "heading" }, "Claude sessions")),
        h("div", { class: `${LOCAL}-body` }, note("Looking on this machine…")))
      pane.insertBefore(section, before)
      const body = section.querySelector(`.${LOCAL}-body`)
      if (!localLoads.has(key)) {
        localLoads.set(key, loads.get(key).catch(() => ({ sessions: [], branch: "" })).then(({ sessions, branch }) =>
          localService("GET", `/pr-sessions?pr=${info.prId}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`, null, 40000)
            .then((rows) => ({ rows, commitsBy: new Map(sessions.filter((s) => s.localId).map((s) => [s.localId, s.commits.length])) }))))
      }
      localLoads.get(key).then(
        ({ rows, commitsBy }) => renderLocal(body, rows, commitsBy, `PR !${info.prId} (${decodeURIComponent(info.repo)})`),
        () => {
          // No local service (or no GM_xmlhttpRequest): the claude.ai links take
          // its place, and no retry on every DOM change.
          localLoads.delete(key)
          noLocal.add(key)
          section.remove()
          before.style.display = ""
        }
      )
    }

    function note(text) {
      const node = document.createElement("div")
      node.className = `${SECTION_CLASS}-note`
      node.textContent = text
      return node
    }

    function renderSessions(body, sessions) {
      if (!sessions.length) {
        body.replaceChildren(note("None linked. Sessions show up here when Claude Code commits with Remote Control on."))
        return
      }
      const list = document.createElement("ul")
      list.className = `${SECTION_CLASS}-list`
      for (const s of sessions) {
        const link = document.createElement("a")
        link.href = s.url
        link.target = "_blank"
        link.rel = "noopener noreferrer"
        link.textContent = s.name || s.label
        link.title = `${s.name ? `${s.name}\n` : ""}${s.label}\n${s.url}\nOpens on claude.ai for the session's owner`
        const meta = document.createElement("div")
        meta.className = `${SECTION_CLASS}-meta`
        const commitCount = s.commits.length && `${s.commits.length} commit${s.commits.length === 1 ? "" : "s"}`
        meta.textContent = [s.wrotePr && "PR description", commitCount, timeAgo(s.when)].filter(Boolean).join(" · ")
        const item = document.createElement("li")
        item.append(link, meta)
        list.append(item)
      }
      body.replaceChildren(list)
    }

    function processOverview() {
      // Only the Overview tab has the side pane.
      const pane = document.querySelector(".repos-overview-right-pane")
      const info = pane && currentPrInfo()
      if (!info) return
      const key = `${info.prefix}/${info.repo}/${info.prId}`
      const existing = pane.querySelector(`.${SECTION_CLASS}`)
      if (existing && existing.dataset.pr === key) {
        const local = pane.querySelector(`.${LOCAL}`)
        if (!local && typeof GM_xmlhttpRequest === "function" && !noLocal.has(key)) addLocalSection(pane, info, key, existing)
        return
      }
      existing?.remove()
      pane.querySelector(`.${LOCAL}`)?.remove()

      const section = document.createElement("div")
      section.className = `${SECTION_CLASS} flex-column rhythm-vertical-8`
      section.dataset.pr = key
      section.innerHTML = `
        <div class="${SECTION_CLASS}-head">
          <div aria-level="2" class="bolt-header-title body-xl m" role="heading">Claude sessions</div>
        </div>
        <div class="${SECTION_CLASS}-body"></div>
      `
      const body = section.querySelector(`.${SECTION_CLASS}-body`)
      body.append(note("Loading…"))
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = `${SECTION_CLASS}-resume`
      btn.dataset.prId = info.prId
      btn.dataset.repo = decodeURIComponent(info.repo)
      btn.dataset.branch = ""
      launcher.attach(btn, "Resume locally")
      section.querySelector(`.${SECTION_CLASS}-head`).append(btn)
      pane.append(section)

      if (!loads.has(key)) loads.set(key, loadSessions(info))
      // With the local service, its list is the side pane's "Claude sessions" and
      // the claude.ai links stay hidden (still loaded: they rank the local rows).
      // The hidden section also marks the pane as done for this PR.
      if (typeof GM_xmlhttpRequest === "function" && !noLocal.has(key)) {
        section.style.display = "none"
        addLocalSection(pane, info, key, section)
      }
      loads.get(key).then(
        ({ sessions, branch }) => {
          btn.dataset.branch = branch
          launcher.refresh(btn)
          renderSessions(body, sessions)
        },
        (e) => {
          console.error(`[ADO Toolbox] Could not load Claude sessions for PR ${info.prId}:`, e)
          // Retry on the next visit to the overview.
          loads.delete(key)
          body.replaceChildren(note("Couldn't load sessions."))
        }
      )
    }

    return {
      name: "PR Claude Sessions",
      match: (url) => url.includes("/pullrequest/"),
      init() { injectStyle(STYLES) },
      process: processOverview,
    }
  }

  // ============================================================
  // Feature 11: Send to Claude Code
  // A ">_" button in each PR comment thread's header hands the thread to a
  // launcher on the user's machine (see createLauncher), with {org}, {project},
  // {repo}, {id} (the PR) and {thread} filled in, prefilled with
  // hammerspoon://cc-thread?…. Only those ids travel: the reference handler
  // (~/.hammerspoon, see README) has cc-pr fetch the thread itself, offers the
  // PR's Claude sessions or a new one, and sends the request to the pick.
  // ============================================================
  function createSendThreadToClaude() {
    const BUTTON_CLASS = "ado-ccthread-btn"

    const STYLES = `
      .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .${BUTTON_CLASS}:hover, .${BUTTON_CLASS}.ado-launcher-open {
        background: var(--palette-black-alpha-6, rgba(0, 0, 0, 0.06));
      }
      .${BUTTON_CLASS}.ado-launcher-sent { color: #107c10; }
    `

    const launcher = createLauncher({
      storageKey: "ado-claude-thread-launch-url",
      defaultTemplate: "hammerspoon://cc-thread?org={org}&project={project}&repo={repo}&pr={id}&thread={thread}",
      heading: "Send comment threads to Claude Code",
      hint: (btn) => `
        Opens a URL on your machine with <code>{org}</code>, <code>{project}</code>, <code>{repo}</code>,
        <code>{id}</code> (the pull request) and <code>{thread}</code> (here <code>${btn.dataset.thread}</code>)
        filled in, so a script there can hand the thread to a Claude Code session (see the Toolbox
        README). Stored in this browser only.`,
      fill: (template, btn) =>
        ["org", "project", "repo", "thread"].reduce(
          (url, key) => url.replaceAll(`{${key}}`, encodeURIComponent(btn.dataset[key])),
          template.replaceAll("{id}", encodeURIComponent(btn.dataset.pr))
        ),
      tooltip: (btn, configured) =>
        "Send this thread to Claude Code\n" +
        (configured ? "(Right-click to change the launcher)" : "(Click to set up the launcher)"),
    })

    // The thread's id: its reply box carries it as a class; a resolved thread has
    // no reply box, so fall back to the id React passes the thread component.
    function threadIdOf(thread) {
      const reply = thread.querySelector('[class*="threadId-"]')
      const match = reply && reply.className.match(/threadId-(\d+)/)
      if (match) return match[1]
      const key = Object.keys(thread).find((k) => k.startsWith("__reactFiber"))
      for (let fiber = key && thread[key], i = 0; fiber && i < 25; fiber = fiber.return, i++) {
        const props = fiber.memoizedProps
        const id = props && (props.threadId ?? (props.thread && props.thread.id))
        if (id) return String(id)
      }
      return null
    }

    function processThreads() {
      const info = currentPrInfo()
      if (!info) return
      const { org, project } = orgAndProject(info.prefix)
      document.querySelectorAll(".repos-discussion-thread").forEach((thread) => {
        if (thread.querySelector(`.${BUTTON_CLASS}`)) return
        // The first comment's header holds the thread's own actions (Copy link,
        // its status) on the right.
        const actions = thread.querySelector(".repos-discussion-comment-header > .justify-end")
        const id = threadIdOf(thread)
        if (!actions || !id) return
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = BUTTON_CLASS
        btn.setAttribute("aria-label", "Send this thread to Claude Code")
        Object.assign(btn.dataset, { org, project, repo: decodeURIComponent(info.repo), pr: info.prId, thread: id })
        launcher.attach(btn)
        actions.insertBefore(btn, actions.firstChild)
      })
    }

    return {
      name: "Send to Claude Code",
      match: (url) => url.includes("/pullrequest/"),
      init() { injectStyle(STYLES) },
      process: processThreads,
    }
  }

  // ============================================================
  // Feature 12: PR Review Clock
  // Times how long you spend reviewing a PR. Off until turned on from the
  // Tampermonkey menu ("Review clock: turn on"); off, it does nothing at all.
  // On a PR you're a reviewer of (not its author) it starts by itself on your
  // first scroll, click or key in Files; a chip before the vote button shows
  // it. Only active time counts:
  //   - no keyboard or mouse anywhere on the Mac for 5 min pauses it, and on
  //     your return you drop the gap, count it, or stop where it began;
  //   - at 60 min, then every 30, or after 20 min without the PR in front of
  //     you, it asks "still reviewing?" and stays paused until you answer;
  //   - voting (or Stop and log) offers to log the time, your vote the outcome.
  // Its state is shared by every ADO tab, so one clock runs at a time.
  // Logged reviews go to a local service (Stan's ado-pr-redirector, see
  // README): GET /idle gives the Mac's idle time, GET/POST /review-sessions
  // keeps the log. Without it the clock runs but can't tell you're away, and
  // logged time waits in this browser until the service answers.
  // ============================================================
  function createReviewClock() {
    const K = {
      on: "ado-rc-enabled",
      state: "ado-rc-state",
      box: "ado-rc-box-min",
      skip: "ado-rc-skip",
      queue: "ado-rc-unsent",
    }
    const AWAY_S = 5 * 60
    const STILL_FIRST_S = 60 * 60
    const STILL_EVERY_S = 30 * 60
    const OFF_PR_MS = 20 * 60 * 1000
    // No tab checked for this long (asleep, or every ADO tab closed): ask.
    const UNWATCHED_MS = 3 * 60 * 1000
    const CHECK_MS = 15 * 1000
    const VOTE_POLL_MS = 60 * 1000
    const VOTES = { 10: "Approved", 5: "Approved with suggestions", "-5": "Waited for author", "-10": "Rejected" }
    const VOTE_ACTION = /^(approve|approve with suggestions|wait for author|reject)$/i
    const CHIP = "ado-rc-chip"
    const POP = "ado-rc-pop"

    // --- storage: GM storage, shared live by every ADO tab ---
    const HAS_GM = typeof GM_getValue === "function" && typeof GM_setValue === "function"
    function read(key, fallback) {
      try {
        if (HAS_GM) return GM_getValue(key, fallback)
        const raw = localStorage.getItem(key)
        return raw == null ? fallback : JSON.parse(raw)
      } catch {
        return fallback
      }
    }
    function write(key, value) {
      try {
        if (HAS_GM) GM_setValue(key, value)
        else localStorage.setItem(key, JSON.stringify(value))
      } catch (e) {
        console.error("[ADO Toolbox] Review clock couldn't save:", e)
      }
    }
    function onOtherTabWrite(key, fn) {
      if (typeof GM_addValueChangeListener === "function") {
        GM_addValueChangeListener(key, (_key, _old, value, remote) => remote && fn(value))
      } else {
        window.addEventListener("storage", (e) => e.key === key && fn(e.newValue == null ? null : JSON.parse(e.newValue)))
      }
    }

    const hub = (method, path, body) => localService(method, path, body)
    async function idleSeconds() {
      try {
        const { idle } = await hub("GET", "/idle")
        return Number.isFinite(idle) ? idle : null
      } catch {
        return null
      }
    }

    // --- a review's time: [start, end] spans in ms; the last is open (end null)
    // while the clock runs ---
    const Spans = {
      total: (spans, now) => spans.reduce((t, [a, b]) => t + Math.max(0, (b ?? now) - a), 0),
      running: (spans) => spans.length > 0 && spans[spans.length - 1][1] == null,
      // End the open span at `at`, never before it began.
      close: (spans, at) => spans.map(([a, b]) => (b == null ? [a, Math.max(a, at)] : [a, b])),
      // Run again from `from`; a `from` no later than the last span's end
      // continues that span, which counts the gap in between.
      open: (spans, from) => {
        const done = Spans.close(spans, from)
        const last = done[done.length - 1]
        return last && from <= last[1] ? [...done.slice(0, -1), [last[0], null]] : [...done, [from, null]]
      },
      // Drop all time after `at`.
      cut: (spans, at) => spans.filter(([a]) => a < at).map(([a, b]) => [a, Math.min(b ?? at, at)]),
    }

    const load = () => read(K.state, null)
    const activeSecs = (s, now = Date.now()) => Math.floor(Spans.total(s.spans, now) / 1000)
    const boxSecs = () => Math.max(1, Number(read(K.box, 30)) || 30) * 60
    const clock = (secs) => {
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60
      const pad = (n) => String(n).padStart(2, "0")
      return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
    }
    const mins = (secs) => {
      const m = Math.round(secs / 60)
      return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    }
    const at = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36) + Date.now().toString(36)).replace(/[^a-z0-9]/gi, "").slice(0, 20)

    // --- the PR on this page ---
    function prHere() {
      const info = currentPrInfo()
      if (!info) return null
      const { org, project } = orgAndProject(info.prefix)
      return { ...info, org, project, repoName: decodeURIComponent(info.repo), key: `${info.prefix}|${info.repo}|${info.prId}` }
    }
    const orgUrl = (p) =>
      location.hostname.toLowerCase() === "dev.azure.com" ? `${location.origin}/${p.prefix.split("/").filter(Boolean)[0]}` : location.origin
    let myId = null
    const facts = new Map() // PR key → Promise<{ title, author, reviewer, vote }>
    function prFacts(p, fresh) {
      if (fresh || !facts.has(p.key)) {
        const job = (async () => {
          if (!myId) myId = (await fetchJson(`${orgUrl(p)}/_apis/connectionData`)).authenticatedUser.id
          const pr = await fetchJson(`${location.origin}${p.prefix}/_apis/git/repositories/${p.repo}/pullRequests/${p.prId}?api-version=7.1`)
          const mine = pr.reviewers.find((r) => r.id === myId)
          return { title: pr.title, author: pr.createdBy.id === myId, reviewer: !!mine, vote: mine ? mine.vote : 0 }
        })()
        job.catch(() => facts.delete(p.key))
        facts.set(p.key, job)
      }
      return facts.get(p.key)
    }
    const known = new Map() // PR key → settled facts, for synchronous rendering
    const reading = new Set() // PR keys whose facts are loading (a failed read isn't retried until reload)
    const sessionsFor = (p) => hub("GET", `/review-sessions?repo=${encodeURIComponent(p.repo)}&pr=${p.id}`)

    // --- state changes ---
    let enabled = false
    let starting = false
    function save(s) {
      write(K.state, s)
      render()
    }
    async function start(p) {
      if (starting || load()) return
      starting = true
      try {
        const f = await prFacts(p).catch(() => null)
        const pr = { prefix: p.prefix, org: p.org, project: p.project, repo: p.repoName, id: Number(p.prId), title: f ? f.title : "", key: p.key }
        const past = await sessionsFor(pr).catch(() => [])
        if (load()) return
        const now = Date.now()
        const { pass, join } = passFor(past, now)
        save({ pr, spans: [[now, null]], prompt: null, notice: null, overShown: false, nextStill: STILL_FIRST_S,
          lastOnPr: now, lastCheck: now, vote: f ? f.vote : 0, pass, sameDay: join ? join.seconds : 0, firstPass: past[0] || null })
      } finally {
        starting = false
      }
    }
    function pause(s, prompt, when) {
      s.spans = Spans.close(s.spans, when)
      s.prompt = prompt
      save(s)
      openPop(true)
      if (document.hidden && typeof GM_notification === "function") {
        const text = prompt.kind === "log" ? `Log your time on !${s.pr.id}?` : prompt.kind === "idle" ? "Paused while you were away." : `Still reviewing !${s.pr.id}?`
        GM_notification({ title: "Review clock", text, timeout: 0, onclick: () => window.focus() })
      }
    }
    function resume(s, from) {
      s.spans = Spans.open(s.spans, from)
      s.prompt = null
      s.lastCheck = Date.now()
      s.lastOnPr = Date.now()
      save(s)
    }
    function askToLog(s, outcome) {
      pause(s, { kind: "log", outcome: outcome || "" }, Date.now())
    }
    async function postSession(session) {
      try {
        await hub("POST", "/review-sessions", { op: "put", session })
        return true
      } catch {
        write(K.queue, [...read(K.queue, []), session].slice(-50))
        return false
      }
    }
    let lastFlush = 0
    async function flushQueue() {
      const queue = read(K.queue, [])
      if (!queue.length || Date.now() - lastFlush < 5 * 60 * 1000) return
      lastFlush = Date.now()
      const left = []
      for (const session of queue) {
        try {
          await hub("POST", "/review-sessions", { op: "put", session })
        } catch {
          left.push(session)
        }
      }
      write(K.queue, left)
    }
    // A PR's reviews on one day are one pass: a log adds to that day's latest
    // pass unless asked for a new one.
    const dayOf = (ms) => new Date(ms).toLocaleDateString("en-CA")
    function passFor(past, when) {
      const join = past.filter((x) => dayOf(x.start) === dayOf(when)).pop() || null
      const next = past.reduce((n, x) => Math.max(n, x.pass || 1), 0) + 1
      return { pass: join ? join.pass || 1 : next, join, next }
    }
    async function logReview(entry, newPass) {
      const past = await sessionsFor({ repo: entry.repo, id: entry.pr }).catch(() => null)
      // Can't see the log: it goes in as a pass of its own once the service answers.
      if (!past) return postSession(entry)
      const { join, next } = passFor(past, entry.start)
      if (!join || newPass) return postSession({ ...entry, pass: next })
      return postSession({
        ...join,
        title: entry.title || join.title,
        start: Math.min(join.start, entry.start),
        end: Math.max(join.end, entry.end),
        seconds: Math.min(86400, join.seconds + entry.seconds),
        outcome: entry.outcome || join.outcome,
        note: [join.note, entry.note].filter(Boolean).join("; ").slice(0, 500),
        manual: !!(join.manual && entry.manual),
      })
    }
    function sessionOf(s, seconds, outcome, note) {
      const spans = Spans.close(s.spans, Date.now())
      return { id: newId(), org: s.pr.org, project: s.pr.project, repo: s.pr.repo, pr: s.pr.id, title: s.pr.title,
        start: spans[0][0], end: spans[spans.length - 1][1], seconds, outcome, pass: s.pass, note }
    }

    // --- the checks, every CHECK_MS in each ADO tab while on ---
    let lastVotePoll = 0
    let voteClickAt = 0
    let checking = false
    async function check() {
      if (!enabled || checking) return
      checking = true
      try {
        flushQueue()
        const first = load()
        if (!first) return
        const here = prHere()
        const onIt = !!here && here.key === first.pr.key && !document.hidden && document.hasFocus()
        // Gather what needs the network first, then apply it to fresh state.
        const idle = Spans.running(first.spans) || (first.prompt?.kind === "idle" && !first.prompt.to) ? await idleSeconds() : null
        let vote = null
        const clicked = Date.now() - voteClickAt < 15000
        if (Spans.running(first.spans) && (clicked || Date.now() - lastVotePoll > VOTE_POLL_MS)) {
          lastVotePoll = Date.now()
          const p = { prefix: first.pr.prefix, repo: encodeURIComponent(first.pr.repo), prId: String(first.pr.id), key: first.pr.key }
          vote = await prFacts(p, true).then((f) => f.vote, () => null)
        }
        const s = load()
        if (!s || s.pr.key !== first.pr.key) return
        const now = Date.now()
        if (onIt) s.lastOnPr = now
        if (!Spans.running(s.spans)) {
          if (s.prompt?.kind === "idle" && !s.prompt.to && idle != null && idle < 60) {
            s.prompt.to = now - idle * 1000
            save(s)
          }
          return
        }
        if (now - s.lastCheck > UNWATCHED_MS) return pause(s, { kind: "still", at: s.lastCheck, lastOnPr: Math.min(s.lastOnPr, s.lastCheck) }, s.lastCheck)
        s.lastCheck = now
        if (idle != null && idle >= AWAY_S) {
          const from = Math.max(now - idle * 1000, s.spans[0][0])
          return pause(s, { kind: "idle", from, to: null }, from)
        }
        if (vote != null) {
          // A reset (0) isn't a vote; a repeat of the same vote is, if it was clicked.
          const voted = vote !== 0 && (vote !== s.vote || clicked)
          s.vote = vote
          if (voted) {
            voteClickAt = 0
            return askToLog(s, VOTES[vote])
          }
        }
        const secs = activeSecs(s, now)
        if (secs >= s.nextStill || now - s.lastOnPr >= OFF_PR_MS) {
          return pause(s, { kind: "still", at: now, lastOnPr: s.lastOnPr }, now)
        }
        if (secs >= boxSecs() && !s.overShown) {
          s.overShown = true
          s.notice = "over"
          chime()
          save(s)
          return openPop(true)
        }
        save(s)
      } catch (e) {
        console.error("[ADO Toolbox] Review clock check failed:", e)
      } finally {
        checking = false
      }
    }

    // --- page activity: starts the clock, and marks you on the PR ---
    let audio = null
    function onActivity(e) {
      if (!enabled || !e.isTrusted) return
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)()
        if (audio.state === "suspended") audio.resume()
      } catch {}
      const p = prHere()
      if (!p) return
      const s = load()
      if (s) {
        if (s.pr.key === p.key && Spans.running(s.spans) && Date.now() - s.lastOnPr > 10000) {
          s.lastOnPr = Date.now()
          write(K.state, s)
        }
        return
      }
      const f = known.get(p.key)
      const inFiles = new URLSearchParams(location.search).get("_a") === "files"
      if (f && f.reviewer && !f.author && inFiles && !read(K.skip, []).includes(p.key)) start(p)
    }
    function onVoteClick(e) {
      if (!enabled) return
      const t = e.target instanceof Element ? e.target : null
      if (!t) return
      const main = t.closest(".repos-pr-header-vote-button .bolt-split-button-main")
      const item = t.closest('[role="menuitem"], .bolt-menuitem-row')
      if (main || (item && VOTE_ACTION.test(item.textContent.trim()))) {
        voteClickAt = Date.now()
        setTimeout(check, 2500)
        setTimeout(check, 7000)
      }
    }
    function chime() {
      if (!audio) return
      try {
        const t = audio.currentTime
        for (const [dt, f] of [[0, 660], [0.2, 880]]) {
          const o = audio.createOscillator(), g = audio.createGain()
          o.frequency.value = f
          g.gain.setValueAtTime(0.0001, t + dt)
          g.gain.exponentialRampToValueAtTime(0.18, t + dt + 0.02)
          g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.4)
          o.connect(g)
          g.connect(audio.destination)
          o.start(t + dt)
          o.stop(t + dt + 0.45)
        }
      } catch {}
    }

    // --- UI ---
    const STYLES = `
      .${CHIP} { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; margin-right: 8px;
        border-radius: 4px; border: 1px solid #c8c6c4; background: #fff; color: rgba(0,0,0,.9); font: inherit; font-size: 13px;
        cursor: pointer; white-space: nowrap; flex-shrink: 0; align-self: center; }
      .${CHIP}:hover { background: #f3f2f1; }
      .${CHIP} b { font-weight: 600; font-variant-numeric: tabular-nums; }
      .${CHIP} .ado-rc-dim { color: #605e5c; }
      .${CHIP}.ado-rc-armed { border-color: #0078d4; background: #eff6fc; color: #004578; font-weight: 600; }
      .${CHIP}.ado-rc-over { border-color: #e0b252; background: #fff4ce; color: #5c3b00; }
      .${CHIP}.ado-rc-ask { border-color: #0078d4; background: #eff6fc; color: #004578; }
      .${CHIP}.ado-rc-paused { background: #f3f2f1; }
      .${CHIP}.ado-rc-elsewhere { border-style: dashed; border-color: #8a8886; }
      .${POP} { position: fixed; z-index: 100000; width: 340px; box-sizing: border-box; background: #fff; color: rgba(0,0,0,.9);
        border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06); padding: 16px;
        display: flex; flex-direction: column; gap: 12px; font-family: "Segoe UI", -apple-system, system-ui, sans-serif; font-size: 13.5px; }
      .${POP} h3 { margin: 0; font-size: 15px; font-weight: 600; }
      .${POP} p { margin: 0; line-height: 1.45; }
      .${POP} .ado-rc-sub { color: #605e5c; font-size: 13px; }
      .${POP} .ado-rc-foot { color: #605e5c; font-size: 12.5px; line-height: 1.45; border-top: 1px solid #edebe9; padding-top: 8px;
        display: flex; gap: 8px; align-items: center; justify-content: space-between; }
      .${POP} .ado-rc-big { font-size: 32px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.5px; }
      .${POP} .ado-rc-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .${POP} .ado-rc-col { display: flex; flex-direction: column; gap: 6px; }
      .${POP} button { font: inherit; font-size: 13px; min-height: 32px; padding: 0 12px; border-radius: 4px; cursor: pointer;
        border: 1px solid #c8c6c4; background: #fff; color: rgba(0,0,0,.9); }
      .${POP} button:hover { background: #f3f2f1; }
      .${POP} button.ado-rc-primary { border-color: #0078d4; background: #0078d4; color: #fff; font-weight: 600; }
      .${POP} button.ado-rc-primary:hover { background: #106ebe; }
      .${POP} button.ado-rc-ghost { border-color: transparent; background: transparent; color: #605e5c; }
      .${POP} button.ado-rc-link { border: 0; background: none; color: #005a9e; padding: 0 4px; min-height: 28px; }
      .${POP} .ado-rc-col button { text-align: left; min-height: 36px; }
      .${POP} .ado-rc-bar { height: 6px; border-radius: 3px; background: #edebe9; overflow: hidden; }
      .${POP} .ado-rc-bar > i { display: block; height: 100%; background: #0078d4; border-radius: 3px; }
      .${POP} .ado-rc-line { display: flex; height: 12px; gap: 2px; }
      .${POP} .ado-rc-line > i { border-radius: 2px; background: #0078d4; min-width: 2px; }
      .${POP} .ado-rc-line > i.ado-rc-gap { background: repeating-linear-gradient(135deg, #e1dfdd 0 4px, #f3f2f1 4px 8px); }
      .${POP} .ado-rc-ticks { display: flex; justify-content: space-between; font-size: 12px; color: #605e5c; font-variant-numeric: tabular-nums; }
      .${POP} .ado-rc-grid { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 6px 10px; align-items: baseline; }
      .${POP} .ado-rc-grid > span:nth-child(odd), .${POP} label { color: #605e5c; }
      .${POP} input { font: inherit; font-size: 13.5px; padding: 5px 8px; border: 1px solid #c8c6c4; border-radius: 4px; min-width: 0; color: rgba(0,0,0,.9); }
      .${POP} .ado-rc-hist { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; }
      .${POP} .ado-rc-hist > span:first-child, .${POP} .ado-rc-hist .ado-rc-when { color: #605e5c; }
      .${POP} .ado-rc-err { color: #a4262c; font-size: 12.5px; }
    `

    function el(tag, attrs, ...kids) {
      const node = document.createElement(tag)
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue
        if (k === "class") node.className = v
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
        else node.setAttribute(k, v === true ? "" : String(v))
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
      return node
    }
    const btn = (label, onclick, cls) => el("button", { type: "button", class: cls, onclick }, label)
    function ring(frac, color, inner) {
      const C = 43.98
      return `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="#e1dfdd" stroke-width="2.5"/>${
        frac > 0 ? `<circle cx="9" cy="9" r="7" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(Math.min(frac, 1) * C).toFixed(1)} 44" transform="rotate(-90 9 9)"/>` : ""
      }${inner || ""}</svg>`
    }
    const PLAY = '<path d="M7.5 6.3v5.4l4-2.7z" fill="currentColor"/>'
    const PAUSE = '<path d="M7.4 6.4v5.2M10.6 6.4v5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'

    // What the chip shows: { cls, html, label }, or null for no chip.
    function chipView(s, p, f) {
      if (!s) {
        if (!f || f.author) return null
        return { cls: "ado-rc-armed", html: `${ring(0, "", PLAY)}Review clock`, label: "Review clock" }
      }
      const secs = activeSecs(s)
      if (s.pr.key !== p.key) {
        return { cls: "ado-rc-elsewhere", html: `${ring(secs / boxSecs(), "#0078d4")}<span class="ado-rc-dim">On !${s.pr.id}</span><b>${clock(secs)}</b>`,
          label: `Review clock is on PR ${s.pr.id}` }
      }
      if (s.prompt) {
        const word = s.prompt.kind === "log" ? "log time?" : s.prompt.kind === "still" ? "still there?" : "away"
        return { cls: "ado-rc-ask", html: `${ring(secs / boxSecs(), "#0078d4", PAUSE)}<b>${clock(secs)}</b><span>${word}</span>`, label: `Review clock paused: ${word}` }
      }
      if (!Spans.running(s.spans)) {
        return { cls: "ado-rc-paused", html: `${ring(secs / boxSecs(), "#8a8886", PAUSE)}<b>${clock(secs)}</b><span class="ado-rc-dim">paused</span>`, label: "Review clock paused" }
      }
      const over = secs - boxSecs()
      if (over > 0) {
        return { cls: "ado-rc-over", html: `${ring(1, "#c27c00")}<b>${clock(secs)}</b><span>+${mins(over)}</span>`, label: `Review clock, ${mins(over)} over the box` }
      }
      return { cls: "", html: `${ring(secs / boxSecs(), "#0078d4")}<b>${clock(secs)}</b><span class="ado-rc-dim">/ ${mins(boxSecs())}</span>`,
        label: `Review clock, ${clock(secs)} of ${mins(boxSecs())}` }
    }

    // A bar of the spans from the first start to `to`, gaps hatched.
    function line(spans, to) {
      const from = spans[0][0]
      const parts = []
      let cursor = from
      for (const [a, b] of spans) {
        if (a > cursor) parts.push(el("i", { class: "ado-rc-gap", style: `flex: ${a - cursor} 1 0` }))
        parts.push(el("i", { style: `flex: ${Math.max(1, (b ?? to) - a)} 1 0` }))
        cursor = b ?? to
      }
      if (to > cursor) parts.push(el("i", { class: "ado-rc-gap", style: `flex: ${to - cursor} 1 0` }))
      return el("div", { class: "ado-rc-line", "aria-hidden": "true" }, parts)
    }
    const ticks = (...labels) => el("div", { class: "ado-rc-ticks" }, labels.map((l) => el("span", null, l)))

    let pop = null
    let popKey = ""
    function closePop() {
      pop?.remove()
      pop = null
      popKey = ""
    }
    function openPop(force) {
      const chip = document.querySelector(`.${CHIP}`)
      if (!chip) return
      if (pop && !force) return closePop()
      renderPop(true)
    }
    function placePop() {
      const chip = document.querySelector(`.${CHIP}`)
      if (!pop || !chip) return closePop()
      const r = chip.getBoundingClientRect()
      pop.style.top = `${Math.round(r.bottom + 6)}px`
      pop.style.left = `${Math.max(8, Math.round(Math.min(r.right, window.innerWidth - 8) - pop.offsetWidth))}px`
    }

    // The popover's content for the current state. Its key changes only when the
    // view must be rebuilt; the ticking numbers update in place.
    function popView(s, p, f) {
      if (!s) return { key: `home|${p.key}`, build: () => homeView(p, f) }
      if (s.pr.key !== p.key) return { key: `elsewhere|${s.pr.key}`, build: () => elsewhereView(s, p) }
      if (s.prompt) return { key: `${s.prompt.kind}|${s.prompt.to || ""}`, build: () => promptView(s) }
      if (s.notice === "over") return { key: "over", build: () => overView(s) }
      return { key: `run|${Spans.running(s.spans)}`, build: () => runView(s) }
    }
    function renderPop(create) {
      if (!pop && !create) return
      const p = prHere()
      if (!p) return closePop()
      const view = popView(load(), p, known.get(p.key))
      if (pop && view.key === popKey) {
        tickPop()
        return placePop()
      }
      if (!pop) {
        pop = el("div", { class: POP, role: "dialog", "aria-label": "Review clock" })
        document.body.append(pop)
      }
      popKey = view.key
      pop.replaceChildren(...[view.build()].flat().filter(Boolean))
      tickPop()
      placePop()
    }
    function tickPop() {
      const s = load()
      if (!pop || !s) return
      const text = clock(activeSecs(s))
      // Only real changes: rewriting the same text is still a DOM mutation,
      // which reruns every feature, this one included.
      pop.querySelectorAll("[data-rc-clock]").forEach((n) => n.textContent !== text && (n.textContent = text))
      const bar = pop.querySelector(".ado-rc-bar > i")
      const width = `${Math.min(100, (activeSecs(s) / boxSecs()) * 100).toFixed(1)}%`
      if (bar && bar.style.width !== width) bar.style.width = width
    }

    function homeView(p, f) {
      const skipped = read(K.skip, []).includes(p.key)
      const startBtn = btn("Start now", () => start(p).then(() => renderPop()), "ado-rc-primary")
      const head = f && f.reviewer
        ? [el("h3", null, "You're a reviewer on this PR"),
          el("p", null, skipped ? "It won't start by itself on this PR." : "The clock starts by itself on your first scroll, click or key in Files. Only active time counts, and it keeps counting while you test the PR somewhere else.")]
        : [el("h3", null, "Review clock"), el("p", null, "You're not a reviewer on this PR, so it won't start by itself.")]
      const actions = el("div", { class: "ado-rc-row" }, startBtn,
        f && f.reviewer && !skipped && btn("Not for this PR", () => {
          write(K.skip, [...read(K.skip, []), p.key].slice(-200))
          closePop()
        }))
      const history = el("div", { class: "ado-rc-col" }, el("span", { class: "ado-rc-sub" }, "Loading your time on this PR…"))
      loadHistory(p, history)
      const minutes = el("input", { type: "number", min: "1", max: "600", value: "15", id: "ado-rc-add-min", style: "width: 70px" })
      const day = el("input", { type: "date", id: "ado-rc-add-day", value: new Date().toLocaleDateString("en-CA") })
      const addErr = el("span", { class: "ado-rc-err", role: "alert" })
      const add = el("div", { class: "ado-rc-col" }, el("strong", null, "Forgot the clock? Add time"),
        el("div", { class: "ado-rc-row" },
          el("label", { for: "ado-rc-add-min" }, "Minutes"), minutes, el("label", { for: "ado-rc-add-day" }, "Day"), day,
          btn("Add", async () => {
            const m = Math.round(Number(minutes.value))
            if (!(m >= 1 && m <= 600)) return (addErr.textContent = "Minutes between 1 and 600.")
            const startMs = new Date(`${day.value || new Date().toLocaleDateString("en-CA")}T12:00:00`).getTime()
            const ok = await logReview({ id: newId(), org: p.org, project: p.project, repo: p.repoName, pr: Number(p.prId), title: f ? f.title : "",
              start: startMs, end: startMs + m * 60000, seconds: m * 60, outcome: "", pass: 1, note: "", manual: true }, false)
            addErr.textContent = ok ? "" : "Saved in this browser; it goes to the local service once that answers."
            loadHistory(p, history)
          })), addErr)
      return [...head, actions, history, add, footer()]
    }
    async function loadHistory(p, box) {
      const pr = { repo: p.repoName, id: Number(p.prId) }
      let list
      try {
        list = await sessionsFor(pr)
      } catch {
        return box.replaceChildren(el("span", { class: "ado-rc-sub" }, "Your logged time shows here when the local service is running."))
      }
      if (!list.length) return box.replaceChildren(el("span", { class: "ado-rc-sub" }, "No time logged on this PR yet."))
      const rows = list.flatMap((x) => {
        const del = btn("Delete", async () => {
          if (del.dataset.armed !== "1") {
            del.dataset.armed = "1"
            del.textContent = "Confirm"
            return
          }
          await hub("POST", "/review-sessions", { op: "delete", id: x.id }).catch(() => {})
          loadHistory(p, box)
        }, "ado-rc-link")
        const edit = btn("Edit", () => {
          const input = el("input", { type: "number", min: "1", max: "600", value: String(Math.round(x.seconds / 60)), style: "width: 64px", "aria-label": "Minutes" })
          const saveBtn = btn("Save", async () => {
            const m = Math.round(Number(input.value))
            if (!(m >= 1 && m <= 600)) return
            await hub("POST", "/review-sessions", { op: "put", session: { ...x, seconds: m * 60 } }).catch(() => {})
            loadHistory(p, box)
          }, "ado-rc-link")
          edit.replaceWith(el("span", { class: "ado-rc-row" }, input, saveBtn))
        }, "ado-rc-link")
        return [el("span", { class: "ado-rc-when" }, new Date(x.start).toLocaleDateString([], { month: "short", day: "numeric" })),
          el("b", null, mins(x.seconds)), el("span", null, x.outcome || (x.manual ? "Added by hand" : "")), el("span", null, edit, del)]
      })
      box.replaceChildren(el("strong", null, `Your time on !${p.prId}`), el("div", { class: "ado-rc-hist" }, rows))
    }
    function footer() {
      const box = el("input", { type: "number", min: "5", max: "240", value: String(boxSecs() / 60), id: "ado-rc-box", style: "width: 56px",
        onchange: (e) => {
          const v = Math.round(Number(e.target.value))
          if (v >= 5 && v <= 240) write(K.box, v)
        } })
      return el("div", { class: "ado-rc-foot" },
        el("span", { class: "ado-rc-row" }, el("label", { for: "ado-rc-box" }, "Time box"), box, "min"),
        btn("Turn the clock off", () => setEnabled(false), "ado-rc-link"))
    }
    function passLine(s) {
      if (s.sameDay) return el("p", null, `Adds to today's ${mins(s.sameDay)} on this PR.`)
      if (s.pass <= 1) return null
      const f = s.firstPass
      return el("p", null, `Pass ${s.pass} on this PR.${f ? ` The 1st was ${mins(f.seconds)} on ${new Date(f.start).toLocaleDateString([], { month: "short", day: "numeric" })}.` : ""}`)
    }
    function stopAndLog(s) {
      askToLog(s, s.vote ? VOTES[s.vote] : "")
    }
    function discardBtn() {
      const b = btn("Discard", () => {
        if (b.dataset.armed !== "1") {
          b.dataset.armed = "1"
          b.textContent = "Discard this time?"
          return
        }
        write(K.state, null)
        closePop()
        render()
      }, "ado-rc-ghost")
      return b
    }
    function runView(s) {
      const running = Spans.running(s.spans)
      return [
        el("div", { class: "ado-rc-row", style: "justify-content: space-between" }, el("h3", null, `Reviewing !${s.pr.id}`),
          el("span", { class: "ado-rc-sub" }, running ? `since ${at(s.spans[0][0])}` : "paused")),
        el("div", { class: "ado-rc-row", style: "align-items: baseline" }, el("span", { class: "ado-rc-big", "data-rc-clock": "" }),
          el("span", { class: "ado-rc-sub" }, `of your ${mins(boxSecs())} box`)),
        el("div", { class: "ado-rc-bar" }, el("i")),
        passLine(s),
        el("div", { class: "ado-rc-row" },
          btn("Stop and log", () => stopAndLog(load()), "ado-rc-primary"),
          running
            ? btn("Pause", () => { const x = load(); x.spans = Spans.close(x.spans, Date.now()); save(x) })
            : btn("Resume", () => resume(load(), Date.now())),
          discardBtn()),
        el("p", { class: "ado-rc-foot" }, "Keeps counting on other tabs and in the terminal. Pauses after 5 minutes with no keyboard or mouse on this Mac."),
      ]
    }
    function overView(s) {
      const dismiss = () => { const x = load(); x.notice = null; save(x); closePop() }
      return [
        el("h3", null, `Past your ${mins(boxSecs())} box`),
        el("p", null, "The box is a nudge, not a limit. It chimed once and won't again."),
        el("div", { class: "ado-rc-row" }, btn("Stop and log", () => stopAndLog(load()), "ado-rc-primary"), btn("Keep going", dismiss)),
      ]
    }
    function elsewhereView(s, p) {
      const secs = activeSecs(s)
      return [
        el("h3", null, `The clock is on !${s.pr.id}`),
        el("p", null, `${clock(secs)} so far${s.pr.title ? ` on ${s.pr.title}` : ""}. Move it here? That review's time is logged first, and you can go back to it later.`),
        el("div", { class: "ado-rc-row" },
          btn("Review this one now", async () => {
            const old = load()
            if (old) {
              const done = { ...old, spans: Spans.close(old.spans, Date.now()) }
              await logReview(sessionOf(done, activeSecs(done), old.vote ? VOTES[old.vote] : "", ""), false)
              write(K.state, null)
            }
            await start(p)
            renderPop()
          }, "ado-rc-primary"),
          btn("Just looking", closePop)),
        el("p", { class: "ado-rc-foot" }, "One clock at a time, so no minute counts twice."),
      ]
    }
    function promptView(s) {
      const q = s.prompt
      if (q.kind === "idle") {
        const to = q.to || Date.now()
        const away = Math.max(1, Math.round((to - q.from) / 60000))
        return [
          el("h3", null, `You were away for ${away} minute${away === 1 ? "" : "s"}`),
          el("p", { class: "ado-rc-sub" }, `No keyboard or mouse from ${at(q.from)}${q.to ? ` to ${at(q.to)}` : " until now"}.`),
          el("div", null, line(s.spans, to), ticks(at(s.spans[0][0]), at(q.from), at(to))),
          el("div", { class: "ado-rc-col" },
            btn(`Drop those ${away} minutes and carry on`, () => resume(load(), Date.now()), "ado-rc-primary"),
            btn("Count them: I was reading or testing", () => resume(load(), q.from)),
            btn(`Stop the review at ${at(q.from)}`, () => stopAndLog(load()))),
          el("p", { class: "ado-rc-foot" }, "The clock stays paused until you pick one."),
        ]
      }
      if (q.kind === "still") {
        const left = q.lastOnPr < q.at - 60000
        return [
          el("h3", null, `Still reviewing !${s.pr.id}?`),
          el("p", { class: "ado-rc-sub" }, `${clock(activeSecs(s))} on the clock${left ? `, and this PR hasn't been in front of you since ${at(q.lastOnPr)}` : ""}. Paused at ${at(q.at)}, when it asked.`),
          el("div", { class: "ado-rc-col" },
            btn("Yes, still reviewing. Count it all and carry on", () => {
              const x = load()
              x.nextStill = activeSecs({ spans: Spans.open(x.spans, q.at) }, Date.now()) + STILL_EVERY_S
              resume(x, q.at)
            }, "ado-rc-primary"),
            btn(`No, I stopped at ${at(left ? q.lastOnPr : q.at)}`, () => {
              const x = load()
              x.spans = Spans.cut(x.spans, left ? q.lastOnPr : q.at)
              if (!x.spans.length) x.spans = [[q.at, q.at]]
              save(x)
              stopAndLog(x)
            })),
          el("p", { class: "ado-rc-foot" }, "Asks at 60 minutes, then every 30, or after 20 minutes away from this PR."),
        ]
      }
      // log
      const secs = activeSecs(s)
      const minutes = el("input", { type: "number", min: "1", max: "600", value: String(Math.max(1, Math.round(secs / 60))), id: "ado-rc-log-min", style: "width: 70px" })
      const note = el("input", { type: "text", id: "ado-rc-log-note", maxlength: "500", placeholder: "Optional, e.g. ran it on alt ports" })
      const err = el("span", { class: "ado-rc-err", role: "alert" })
      const newPass = el("input", { type: "checkbox", id: "ado-rc-new-pass" })
      const passCell = s.sameDay
        ? el("span", { class: "ado-rc-col", style: "gap: 4px" }, `Adds to today's ${mins(s.sameDay)}`,
          el("label", { for: "ado-rc-new-pass", class: "ado-rc-row", style: "gap: 6px" }, newPass, "Count as a new pass"))
        : el("span", null, s.pass > 1 ? `${s.pass} on this PR` : "1st on this PR")
      const end = s.spans[s.spans.length - 1][1] ?? Date.now()
      return [
        el("div", { class: "ado-rc-col", style: "gap: 2px" }, el("h3", null, `Log ${mins(secs)} on !${s.pr.id}?`),
          el("span", { class: "ado-rc-sub" }, q.outcome ? "Your vote is in. This only records your time." : "Nothing goes to the PR; this only records your time.")),
        el("div", null, line(s.spans, end), ticks(at(s.spans[0][0]), at(end))),
        el("div", { class: "ado-rc-grid" },
          el("span", null, "Outcome"), el("span", null, q.outcome || "No vote"),
          el("span", null, "Pass"), passCell,
          el("label", { for: "ado-rc-log-min" }, "Minutes"), minutes,
          el("label", { for: "ado-rc-log-note" }, "Note"), note),
        el("div", { class: "ado-rc-row" },
          btn("Log it", async () => {
            const m = Math.round(Number(minutes.value))
            if (!(m >= 1 && m <= 600)) return (err.textContent = "Minutes between 1 and 600.")
            const x = load()
            const seconds = m === Math.max(1, Math.round(secs / 60)) ? secs : m * 60
            const ok = await logReview(sessionOf(x, seconds, q.outcome, note.value.trim()), newPass.checked)
            write(K.state, null)
            closePop()
            render()
            if (!ok) console.warn("[ADO Toolbox] Review clock: local service unreachable; the session waits in this browser.")
          }, "ado-rc-primary"),
          btn("Keep the clock going", () => resume(load(), Date.now())),
          discardBtn()),
        err,
      ]
    }

    // --- the chip ---
    function render() {
      if (!enabled) {
        document.querySelector(`.${CHIP}`)?.remove()
        return closePop()
      }
      const p = prHere()
      const anchor = p && document.querySelector(".repos-pr-header-vote-button")
      let chip = document.querySelector(`.${CHIP}`)
      if (!anchor) {
        chip?.remove()
        return closePop()
      }
      if (!known.has(p.key) && !reading.has(p.key)) {
        reading.add(p.key)
        prFacts(p).then(
          (f) => {
            known.set(p.key, f)
            reading.delete(p.key)
            render()
          },
          (e) => console.error("[ADO Toolbox] Review clock couldn't read the PR:", e)
        )
      }
      const view = chipView(load(), p, known.get(p.key))
      if (!view) {
        chip?.remove()
        return closePop()
      }
      if (!chip || chip.nextElementSibling !== anchor) {
        chip?.remove()
        chip = el("button", { type: "button", class: CHIP, onclick: () => openPop(false) })
        anchor.parentElement.insertBefore(chip, anchor)
      }
      const cls = `${CHIP} ${view.cls}`.trim()
      if (chip.className !== cls) chip.className = cls
      if (chip.dataset.html !== view.html) {
        chip.dataset.html = view.html
        chip.innerHTML = view.html
      }
      if (chip.getAttribute("aria-label") !== view.label) chip.setAttribute("aria-label", view.label)
      renderPop(false)
    }

    let listening = false
    let timers = []
    function setEnabled(on) {
      enabled = on
      write(K.on, on)
      registerMenu()
      if (on) startWatching()
      else stopWatching()
      render()
    }
    function startWatching() {
      if (!listening) {
        listening = true
        for (const type of ["pointerdown", "keydown", "wheel"]) document.addEventListener(type, onActivity, { capture: true, passive: true })
        document.addEventListener("click", onVoteClick, true)
        document.addEventListener("keydown", (e) => e.key === "Escape" && pop && closePop())
        document.addEventListener("pointerdown", (e) => {
          if (pop && !pop.contains(e.target) && !e.target.closest?.(`.${CHIP}`)) closePop()
        }, true)
        window.addEventListener("resize", placePop)
        // A question another tab raised opens when you come back to its PR.
        document.addEventListener("visibilitychange", () => {
          const s = enabled && !document.hidden && load()
          const p = s && s.prompt && prHere()
          if (p && p.key === s.pr.key) openPop(true)
        })
        onOtherTabWrite(K.state, () => enabled && render())
      }
      if (!timers.length) timers = [setInterval(check, CHECK_MS), setInterval(() => enabled && render(), 1000)]
      check()
    }
    function stopWatching() {
      timers.forEach(clearInterval)
      timers = []
    }
    let menuId = null
    function registerMenu() {
      if (typeof GM_registerMenuCommand !== "function") return
      if (menuId != null && typeof GM_unregisterMenuCommand === "function") GM_unregisterMenuCommand(menuId)
      menuId = GM_registerMenuCommand(enabled ? "Review clock: turn off" : "Review clock: turn on", () => setEnabled(!enabled))
    }

    return {
      name: "PR Review Clock",
      match: () => true,
      init() {
        injectStyle(STYLES)
        enabled = read(K.on, false) === true
        registerMenu()
        onOtherTabWrite(K.on, (v) => {
          enabled = v === true
          registerMenu()
          if (enabled) startWatching()
          else stopWatching()
          render()
        })
        if (enabled) startWatching()
      },
      process() {
        if (enabled) render()
      },
      _test: { Spans },
    }
  }

  // ============================================================
  // Controller
  // ============================================================
  const FEATURES = [
    createFilePathTools(),
    createBranchNameTools(),
    createHotkeys(),
    createPrDashboardFilters(),
    createOpenInVsCode(),
    createWorkItemHotkeys(),
    createWorkItemModal(),
    createWorkOnInClaude(),
    createPrDashboardCommenters(),
    createPrClaudeSessions(),
    createSendThreadToClaude(),
    createReviewClock(),
  ]

  function runFeature(f) {
    try {
      if (f.match && !f.match(location.href)) return
      if (!f._inited) {
        f._inited = true
        f.init?.()
      }
      f.process?.()
    } catch (e) {
      console.error(`[ADO Toolbox] Feature "${f.name}" failed:`, e)
    }
  }

  function tick() {
    for (const f of FEATURES) runFeature(f)
  }

  // Azure DevOps is a single-page app: re-run on every DOM mutation so features
  // initialize and process the right pages even after in-app navigation.
  const observer = new MutationObserver(tick)
  observer.observe(document.body, { childList: true, subtree: true })
  tick()
})()
