// ==UserScript==
// @name         Azure DevOps PR Hotkeys
// @namespace    https://www.seldoncortex.com/
// @version      2024-03-14
// @description  Keyboard shortcuts for Azure Devops PRs
// @author       Stan Stanislaus
// @homepage     https://www.seldoncortex.com/
// @match        **dev.azure**
// @match        **visualstudio**
// @include      **dev.azure**
// @include      **visualstudio**
// @icon         https://www.seldoncortex.com/favicon.ico
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    const showOnlyActiveComments = (event) => {
        if (event.key === 'ArrowRight' && event.ctrlKey && document.activeElement.nodeName !== "TEXTAREA" && document.activeElement.nodeName !== "INPUT") {
        const nodeArr = Array.from(document.querySelectorAll('.bolt-button, .enabled, .bolt-focus-treatment')).filter((x) => x.innerText && x.innerText.includes('Show everything'))
        nodeArr[0].click()
        const nodeArrTwo = Array.from(document.querySelectorAll('#__bolt-active_comments')).filter((x) => x.innerText && x.innerText.includes('Active comments'))
        nodeArrTwo[0].click()
        console.log(nodeArrTwo)
        }
    }

     const showAllComments = (event) => {
        if (event.key === 'ArrowLeft' && event.ctrlKey && document.activeElement.nodeName !== "TEXTAREA" && document.activeElement.nodeName !== "INPUT") {
        const nodeArr = Array.from(document.querySelectorAll('.bolt-button, .enabled, .bolt-focus-treatment')).filter((x) => x.innerText && x.innerText.includes('Active comments'))
        nodeArr[0].click()

        const nodeArrTwo = Array.from(document.querySelectorAll('#__bolt-everything')).filter((x) => x.innerText && x.innerText.includes('Show everything'))
        console.log(nodeArrTwo)
        nodeArrTwo[0].click()
        console.log(nodeArrTwo)
        }
    }


    document.addEventListener('keyup', showOnlyActiveComments, false);
    document.addEventListener('keyup', showAllComments, false);
    })();