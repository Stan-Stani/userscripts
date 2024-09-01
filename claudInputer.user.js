// ==UserScript==
// @name         Claude Inputer
// @namespace    https://www.seldoncortex.com/
// @version      2024-03-18
// @description  try to take over the world!
// @author       Stan Stanislaus
// @match        https://claude.ai/chat/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=claude.ai
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    
    const focusInputOnShiftEsc = (event) => {
        if (event.shiftKey && event.key === 'Escape') {
            event.stopPropagation()
            event.preventDefault()
            const claudeInput = document.querySelector('div.ProseMirror.break-words')
            claudeInput.focus()
        }
    }

    document.addEventListener('keydown', focusInputOnShiftEsc)
    
    })();