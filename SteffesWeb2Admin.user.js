// ==UserScript==
// @name         SteffesWeb2Admin
// @namespace    https://www.seldoncortex.com/
// @version      2024-05-13
// @description  try to take over the world!
// @author       Stan Stanislaus
// @match        *://*/*
// @icon         https://steffesgroup.dev
// @grant        GM_openInTab
// @run-at       context-menu
// ==/UserScript==


(function() {
    'use strict';
    console.log(window.location.pathname)
    /* \/ matches a forward slash (escaped with a backslash)
auctions matches the literal string "auctions"
\/ matches another forward slash
[a-f0-9]{8} matches exactly 8 characters that can be lowercase letters a to f or digits 0 to 9
- matches a hyphen
[a-f0-9]{4} matches exactly 4 characters that can be lowercase letters a to f
*/
    const auctionPath = window.location.pathname.match(/\/auctions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/?/)?.[0]
    if (auctionPath) {
        window.location.replace(`http://localhost:3000/admin${auctionPath}profile`);
    }

})();