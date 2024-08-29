// ==UserScript==
// @name         azureDevops-branchNameFromWI
// @namespace    https://www.seldoncortex.com/
// @version      2024-08-02
// @description  Click on a card in a sprint board to copy its name in a git branch friendly format to the clipboard.
// @author       You
// @match        https://*.visualstudio.com/Core%20API/_sprints/taskboard/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=visualstudio.com
// @grant        none
// ==/UserScript==

; (function () {
    "use strict"

    function requestNotificationPermission() {

        Notification.requestPermission().then((permission) => {
            if (permission === "granted") {
                console.log("Notification permission granted");
            } else {
                console.log("Notification permission denied");
            }
        });

    }

    // Function to send a notification
    function sendNotification(title, options = {}) {
        if (Notification.permission === "granted") {
            const notification = new Notification(title, options);

            notification.onclick = function () {
                window.focus();
                this.close();
            };
        } else {
            console.error("Notifications are not supported or permission not granted");
        }
    }

    // Example usage
    requestNotificationPermission();



// @todo remove non alphanumeric characters like - and :
    function toKebabCase(str, prefix = '') {
        console.log('running TO KEBAB CASE')
        // The regex pattern /(?:^\w|[A-Z]|\s\w)/g matches:
        // ^\w: the first word character in the string.
        // [A-Z]: any uppercase letter.feat/ImproveDevExFunctions-v4feat/ImproveDevExFunctions-v4
        // \s\w: a space followed by a word character.
        // TODO: need first letter following num
        const computedStr = str
            .trim()
            .toLowerCase()
            .replace(/(?:^\w|[A-Z]|\s\w)/g, (firstChar, index) => {
                const firstCharButLowercase = firstChar.toLowerCase().trim()
                if (index === 0) {
                    return firstCharButLowercase
                }
                // console.log(firstCharButLowercase)
                return `-${firstCharButLowercase}`

            }).replace(/[\d]+/g, (digitGroup) => `${digitGroup}-`)
            .replace(/\s+/g, '')
        console.log('Lalonde', computedStr)
        // computedStr = computedStr.concat(prefix, computedStr)
        sendNotification('Work item name copied to clipboard!')
        return computedStr
    }

    setTimeout(() => {
        const titleSpans = document.querySelectorAll('.id-title-container')
        titleSpans.forEach((element) => {
            element.addEventListener('click', (e) => {
                console.log('lalonde', element)
                // if (element.querySelector('[aria-label="Bug"]')) {
                //     navigator.clipboard.writeText(toKebabCase(e.currentTarget.innerText, 'bug/'))
                // } else if (element.querySelector('[aria-label="Bug"]')) {
                //     // return navigator.clipboard.writeText(toKebabCase(e.currentTarget.innerText, ));
                // } else if (element.querySelector('[aria-label="Change Request"]')) {
                //     navigator.clipboard.writeText(toKebabCase(e.currentTarget.innerText, 'cr/'))
                // } else if (element.querySelector('[aria-label="User Story"]')) {
                //     navigator.clipboard.writeText(toKebabCase(e.currentTarget.innerText, 'us/'))
                // } else if (element.querySelector('[aria-label="Feature"]')) {
                //     navigator.clipboard.writeText(toKebabCase(e.currentTarget.innerText, 'feat/'))
                // } else {
                    return navigator.clipboard.writeText(toKebabCase(e.currentTarget.innerText));
                // }
             
            }
            )
        })
    }, 5000)
})()
