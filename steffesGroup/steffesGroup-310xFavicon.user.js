// ==UserScript==
// @name         steffesGroup310xFavicon
// @namespace    https://www.seldoncortex.com/
// @version      2026-08-04.2
// @description  Swap the favicon on localhost 310X dev instances so they don't look like default Steffes tabs
// @author       Stan Stanislaus
// @match        *://localhost/*
// @match        *://127.0.0.1/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

;(function () {
  "use strict"

  // @match patterns ignore the port, so gate on it here: only 3100-3109.
  if (!/^310\d$/.test(window.location.port)) return

  const lastDigit = window.location.port.slice(-1)

  // One background color per port so 3101 vs 3102 is obvious at a glance.
  const PORT_COLORS = [
    "#e63946", // 3100 red
    "#f77f00", // 3101 orange
    "#fcbf49", // 3102 yellow
    "#2a9d8f", // 3103 teal
    "#43aa8b", // 3104 green
    "#577590", // 3105 slate
    "#4361ee", // 3106 blue
    "#7209b7", // 3107 purple
    "#f72585", // 3108 pink
    "#6d6875", // 3109 gray
  ]
  const bg = PORT_COLORS[Number(lastDigit)]

  function buildFaviconDataUrl() {
    const size = 64
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext("2d")

    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = "#ffffff"
    ctx.font = "bold 44px -apple-system, Helvetica, Arial, sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    // Nudge down slightly; textBaseline "middle" sits a bit high for digits.
    ctx.fillText(lastDigit, size / 2, size / 2 + 3)

    return canvas.toDataURL("image/png")
  }

  const dataUrl = buildFaviconDataUrl()
  const MARKER = "data-favicon-310x"

  function ourLink() {
    return document.head.querySelector(`link[${MARKER}]`)
  }

  function iconLinks() {
    return [...document.head.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')]
  }

  function needsWork() {
    const ours = ourLink()
    if (!ours || ours.href !== dataUrl) return true
    const links = iconLinks()
    // Ours must be last so the browser prefers it over the app's icons.
    if (links[links.length - 1] !== ours) return true
    return links.some((el) => el !== ours && el.href !== dataUrl)
  }

  function applyFavicon() {
    // Never remove framework-owned <link> elements — React 19 keeps refs to
    // its hoisted head tags and crashes unmounting one that's already been
    // detached. Repoint their href instead.
    for (const el of iconLinks()) {
      if (!el.hasAttribute(MARKER) && el.href !== dataUrl) el.href = dataUrl
    }
    let ours = ourLink()
    if (!ours) {
      ours = document.createElement("link")
      ours.rel = "icon"
      ours.type = "image/png"
      ours.href = dataUrl
      ours.setAttribute(MARKER, "true")
    }
    document.head.appendChild(ours)
  }

  function ensureFavicon() {
    // Idempotent: once the head is in the desired state this no-ops, so the
    // observer seeing our own mutations can't loop.
    if (document.head && needsWork()) applyFavicon()
  }

  function start() {
    ensureFavicon()
    new MutationObserver(ensureFavicon).observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    })
  }

  if (document.head) {
    start()
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  }
})()
