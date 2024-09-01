// ==UserScript==
// @name         steffesGroupRichTextEditorFill
// @namespace    https://www.seldoncortex.com/
// @version      2024-07-24
// @description  try to take over the world!
// @author       Stan Stanislaus
// @match        http://localhost:3000/admin/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    (function() {
        // Store references to the original methods
        var originalPushState = history.pushState;
        var originalReplaceState = history.replaceState;
    
        // Override pushState
        history.pushState = function() {
            // Call the original method
            originalPushState.apply(history, arguments);
            
            // Dispatch a custom event or call a function
            var event = new Event('pushstate');
            window.dispatchEvent(event);
            
            // You can also directly call a function here
            // handleHistoryChange();
        };
    
        // Override replaceState
        history.replaceState = function() {
            // Call the original method
            originalReplaceState.apply(history, arguments);
            
            // Dispatch a custom event or call a function
            var event = new Event('replacestate');
            window.dispatchEvent(event);
            
            // You can also directly call a function here
            // handleHistoryChange();
        };
    })();
    
    function isCreatingLot(string) {
        if (string.includes("lot") && string.includes("create")) {
            return true
        }
    }

    function addTextToFirstInstanceOfTinyMCEFirst() {
        setTimeout(() => {
            const firstIframe = document.getElementsByTagName('iframe')[0]
            firstIframe.contentDocument.body.innerText = 'Yo Yo Yo Yo, Stan used his Tampermonkey userscript to auto fill this field and save him time! If you\'re interested in saving yourself time head over to https://github.com/Stan-Stani/userscripts/raw/main/steffesGroup/steffesGroup-RichTextEditorFill.user.js and grab the script for yourself. *Psst*, it helps if you have Tampermonkey installed: https://www.tampermonkey.net/'
            window.tinymce.triggerSave()
        }, 3000)
    }

    // Example event listeners for custom events
    window.addEventListener('pushstate', function() {
        // console.log('pushState was called:', window.location.href);

        if (isCreatingLot(window.location.href)){
            addTextToFirstInstanceOfTinyMCEFirst()
        }
        
    });
    
    window.addEventListener('replacestate', function() {
        // console.log('replaceState was called:', window.location.href);
        if (isCreatingLot(window.location.href)){
            addTextToFirstInstanceOfTinyMCEFirst()
        }
        
    });
    
    // // Example usage
    // history.pushState({}, '', '/new-url');  // This should trigger the pushstate event
    // history.replaceState({}, '', '/another-url');

    


    // Your code here...
})();