// ==UserScript==
// @name         Azure DevOps Toolbox
// @namespace    https://www.seldoncortex.com/
// @version      2026-08-26.1
// @description  All-in-one Azure DevOps helpers: PR dashboard filters, file-path copy buttons, branch-name copy buttons, PR keyboard shortcuts, and open-PR-in-VS-Code.
// @author       Stan Stanislaus
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=visualstudio.com
// @grant        none
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

  // Identify the PR the current page belongs to. Works for both
  // dev.azure.com/{org}/{project}/_git/... and legacy
  // {account}.visualstudio.com/[{collection}/]{project}/_git/... — REST API and
  // PR page paths both live under the prefix that precedes "/_git/".
  function currentPrInfo() {
    const path = location.pathname
    const idx = path.indexOf("/_git/")
    if (idx === -1) return null
    const prefix = path.slice(0, idx)
    const rest = path.slice(idx + "/_git/".length)
    const repo = rest.split("/")[0]
    const m = rest.match(/pullrequest\/(\d+)/i)
    if (!repo || !m) return null
    return { prefix, repo, prId: m[1] }
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
      sourceLink.insertAdjacentElement("afterend", btn)

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
  // Controller
  // ============================================================
  const FEATURES = [
    createFilePathTools(),
    createBranchNameTools(),
    createHotkeys(),
    createPrDashboardFilters(),
    createOpenInVsCode(),
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
