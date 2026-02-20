// ==UserScript==
// @name         Azure DevOps PR - File Path Tools
// @namespace    https://www.seldoncortex.com/
// @version      2026-02-20
// @description  Show full file path on hover and add copy-to-clipboard buttons for file paths in Azure DevOps PR comments and file diffs
// @author       Stan Stanislaus
// @match        https://dev.azure.com/*/_git/*/pullrequest/*
// @match        https://*.visualstudio.com/*/_git/*/pullrequest/*
// @grant        none
// ==/UserScript==

;(function () {
  "use strict"

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
    const trimmed = trimPath(fullPath)
    btn.title = trimmed !== fullPath
      ? `Copy: ${trimmed}\n(Shift+click for full path)\n(Right-click to manage prefixes)`
      : `Copy: ${fullPath}\n(Right-click to add strip prefix)`
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

  // --- Styles ---
  const style = document.createElement("style")
  style.textContent = `
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
  document.head.appendChild(style)

  const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 2h7a2 2 0 0 1 2 2v9h-1V4a1 1 0 0 0-1-1H4V2zm-2 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1v8h8V6H2z"/>
  </svg>`

  const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M13.854 3.146a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 9.793l6.646-6.647a.5.5 0 0 1 .708 0z"/>
  </svg>`

  function makeCopyBtn(fullPath) {
    const btn = document.createElement("button")
    btn.className = "ado-fp-copy-btn"
    btn.dataset.fullPath = fullPath
    updateBtnTitle(btn)
    btn.innerHTML = COPY_ICON

    btn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (activePopover) { closePopover(); return }
      const pathToCopy = e.shiftKey ? fullPath : trimPath(fullPath)
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

  // --- Overview tab: comment thread file headers ---
  function processCommentFileHeaders() {
    document
      .querySelectorAll(`.comment-file-header-title:not([${PROCESSED_ATTR}])`)
      .forEach((titleRow) => {
        titleRow.setAttribute(PROCESSED_ATTR, "1")

        const link = titleRow.querySelector("a.comment-file-header-link")
        if (!link) return

        const pathSpan = link.nextElementSibling
        let fullPath =
          pathSpan && pathSpan.textContent.trim().startsWith("/")
            ? pathSpan.textContent.trim()
            : ""

        if (!fullPath) {
          try {
            const url = new URL(link.href, location.origin)
            fullPath = decodeURIComponent(url.searchParams.get("path") || "")
          } catch {}
        }

        if (!fullPath) return

        link.title = fullPath
        if (pathSpan) pathSpan.title = fullPath

        const btn = makeCopyBtn(fullPath)
        btn.style.alignSelf = "center"
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

  function processAll() {
    processCommentFileHeaders()
    processFilesTabHeaders()
  }

  const observer = new MutationObserver(processAll)
  observer.observe(document.body, { childList: true, subtree: true })
  processAll()
})()
