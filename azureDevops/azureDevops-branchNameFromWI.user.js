// ==UserScript==
// @name         Azure DevOps - Branch Name from Work Item
// @namespace    https://www.seldoncortex.com/
// @version      2026-02-20.3
// @description  Adds a copy button to sprint board cards and work item pages to copy the branch name (e.g. bug/14826-title, cr/14826-title).
// @author       Stan Stanislaus
// @match        https://*.visualstudio.com/*/_sprints/taskboard/*
// @match        https://dev.azure.com/*/_sprints/taskboard/*
// @match        https://*.visualstudio.com/*/_workitems/edit/*
// @match        https://dev.azure.com/*/_workitems/edit/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=visualstudio.com
// @grant        none
// ==/UserScript==

;(function () {
  "use strict"

  const PROCESSED_ATTR = "data-bn-processed"

  // --- Styles ---
  const style = document.createElement("style")
  style.textContent = `
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
  `
  document.head.appendChild(style)

  const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 2h7a2 2 0 0 1 2 2v9h-1V4a1 1 0 0 0-1-1H4V2zm-2 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1v8h8V6H2z"/>
  </svg>`

  const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M13.854 3.146a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 9.793l6.646-6.647a.5.5 0 0 1 .708 0z"/>
  </svg>`

  const TYPE_PREFIXES = {
    "Bug": "bug",
    "Change Request": "cr",
    "User Story": "feat",
    "Feature": "feat",
    "Task": "task",
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
        const typeLabel = card.querySelector('[role="img"]')?.getAttribute("aria-label") ?? ""
        const prefix = TYPE_PREFIXES[typeLabel] ?? "feat"
        const id = card.querySelector(".font-weight-semibold.selectable-text")?.innerText?.trim()
        if (!id) return
        const titleLink = card.querySelector("a.title")
        if (!titleLink) return
        const title = toKebabCase(titleLink.innerText)
        titleLink.parentElement.appendChild(makeCopyBtn(`${prefix}/${id}-${title}`))
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

    const typeLabel = header.querySelector('[role="img"]')?.getAttribute("aria-label") ?? ""
    const prefix = TYPE_PREFIXES[typeLabel] ?? "feat"
    const pathMatch = window.location.pathname.match(/_workitems\/edit\/(\d+)/)
    const queryMatch = new URLSearchParams(window.location.search).get("workitem")
    const id = pathMatch?.[1] ?? queryMatch
    if (!id) return

    titleContainer.appendChild(
      makeCopyBtn(() => `${prefix}/${id}-${toKebabCase(titleInput.value)}`)
    )
  }

  function processAll() {
    processCards()
    processWorkItemPage()
  }

  const observer = new MutationObserver(processAll)
  observer.observe(document.body, { childList: true, subtree: true })
  processAll()
})()
