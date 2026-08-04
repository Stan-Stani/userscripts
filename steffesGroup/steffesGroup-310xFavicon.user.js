// ==UserScript==
// @name         steffesGroup310xFavicon
// @namespace    https://www.seldoncortex.com/
// @version      2026-08-04.1
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
  let applying = false

  function applyFavicon() {
    applying = true
    try {
      document
        .querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
        .forEach((el) => el.remove())

      const link = document.createElement("link")
      link.rel = "icon"
      link.type = "image/png"
      link.href = dataUrl
      link.setAttribute(MARKER, "true")
      document.head.appendChild(link)
    } finally {
      applying = false
    }
  }

  function ensureFavicon() {
    if (applying || !document.head) return
    const current = document.head.querySelector(`link[${MARKER}]`)
    const strays = document.head.querySelectorAll(
      `link[rel~="icon"]:not([${MARKER}]), link[rel="shortcut icon"]:not([${MARKER}])`
    )
    if (!current || strays.length) applyFavicon()
  }

  function start() {
    ensureFavicon()
    // SPAs and dev servers love re-injecting their own favicon; win the fight.
    new MutationObserver(ensureFavicon).observe(document.head, { childList: true })
  }

  if (document.head) {
    start()
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  }
})()
