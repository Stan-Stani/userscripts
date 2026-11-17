// ==UserScript==
// @name         Save AI coding quote
// @namespace    https://www.seldoncortex.com/quotes
// @version      0.2.2
// @description  Tap the ❝ button on a Reddit, YouTube or Hacker News comment (or select text anywhere and press Alt+Shift+Q) to file it, with its source and ancestors, into the ai-coding-quotes repo.
// @match        *://*/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      www.seldoncortex.com
// @updateURL    https://raw.githubusercontent.com/Stan-Stani/userscripts/main/aiCodingQuotes/aiCodingQuotes.user.js
// @downloadURL  https://raw.githubusercontent.com/Stan-Stani/userscripts/main/aiCodingQuotes/aiCodingQuotes.user.js
// ==/UserScript==
'use strict';

const ENDPOINT = 'https://www.seldoncortex.com/quotes/api/quotes';

// target: an element inside the comment to save (the ❝ button). Without it, the current text selection is used.
async function extractQuote(target) {
  let selection = '';
  let node = target || null;
  if (!node) {
    const sel = window.getSelection();
    selection = sel ? sel.toString().trim() : '';
    if (!selection) return { error: 'no text selected' };
    node = sel.anchorNode;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node) return { error: 'no selection anchor' };
  }

  const host = location.hostname;
  const abs = (href) => new URL(href, location.href).toString();
  const num = (s) => {
    if (s == null) return null;
    const m = String(s).trim().match(/^(-?[\d.,]+)\s*([KkMm])?$/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Math.round(n * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
  };
  const hash = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const show = () => {};

  // ---------- Reddit (new "shreddit" UI) ----------
  if (/(^|\.)reddit\.com$/.test(host)) {
    const blockText = (n) => {
      const t = n.tagName;
      if (t === 'BLOCKQUOTE') return [...n.children].map(blockText).join('\n\n').split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
      if (t === 'UL' || t === 'OL') return [...n.children].map((li, i) => (t === 'OL' ? i + 1 + '. ' : '- ') + li.innerText.trim()).join('\n');
      return n.innerText.trim();
    };
    const post = document.querySelector('shreddit-post');
    if (!post) return { error: 'open the post or comment permalink page (old.reddit is not supported)' };
    const postId = (post.getAttribute('id') || '').replace(/^t3_/, '');
    const postBody = post.querySelector('[slot="text-body"]');
    const postText = postBody ? [...(postBody.querySelector('[id$="-post-rtjson-content"]') || postBody).children].map(blockText).filter(Boolean).join('\n\n') : null;
    const source = {
      site: 'reddit', id: postId, url: abs(post.getAttribute('permalink')),
      title: post.getAttribute('post-title'), author: post.getAttribute('author'),
      subreddit: (post.getAttribute('subreddit-prefixed-name') || '').replace(/^r\//, ''),
      text: postText || undefined,
    };
    const leaf = node.closest('shreddit-comment');
    if (!leaf) {
      // Selection is in the post itself: save the post as the quote.
      show(post);
      return { source, comments: [{ id: postId, author: source.author, created: post.getAttribute('created-timestamp'), score: num(post.getAttribute('score')), parent_id: null, url: source.url, text: postText, saved: true, selection }] };
    }
    const chain = [];
    for (let c = leaf; c; c = c.parentElement && c.parentElement.closest('shreddit-comment')) chain.unshift(c);
    const comments = chain.map((c) => {
      const id = c.getAttribute('thingid').replace(/^t1_/, '');
      const body = c.querySelector(`#t1_${id}-comment-rtjson-content`);
      const parent = (c.getAttribute('parentid') || '').replace(/^t1_/, '') || null;
      return {
        id, author: c.getAttribute('author'), created: c.getAttribute('created'),
        score: num(c.getAttribute('score')), parent_id: parent,
        url: abs(c.getAttribute('permalink') || `/r/${source.subreddit}/comments/${postId}/comment/${id}/`),
        deleted: !body, text: body ? [...body.children].map(blockText).filter(Boolean).join('\n\n') : null,
        saved: c === leaf, selection: c === leaf ? selection : undefined,
      };
    });
    show(chain[0]);
    return { source, comments };
  }

  // ---------- YouTube ----------
  if (/(^|\.)youtube\.com$/.test(host)) {
    const vid = new URL(location.href).searchParams.get('v') || (location.pathname.match(/\/shorts\/([\w-]+)/) || [])[1];
    if (!vid) return { error: 'not a video page' };
    const source = {
      site: 'youtube', id: vid, url: `https://www.youtube.com/watch?v=${vid}`,
      title: (document.querySelector('ytd-watch-metadata h1') || {}).innerText?.trim() || document.title.replace(/ - YouTube$/, ''),
      author: (document.querySelector('ytd-watch-metadata ytd-channel-name a, ytd-video-owner-renderer ytd-channel-name a') || {}).innerText?.trim() || null,
    };
    const leaf = node.closest('ytd-comment-view-model, ytd-comment-renderer');
    if (!leaf) return { error: 'select text inside a YouTube comment' };
    const read = (c) => {
      const href = c.querySelector('#published-time-text a')?.getAttribute('href') || '';
      const id = new URL(href, location.href).searchParams.get('lc');
      const published = c.querySelector('#published-time-text')?.innerText.trim() || '';
      // YouTube only shows "3 weeks ago" etc.; turn that into an approximate date.
      const rel = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(published);
      const unit = rel && { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2].toLowerCase()];
      const created = rel ? new Date(Date.now() - Number(rel[1]) * unit).toISOString().slice(0, 10) : null;
      return {
        id, author: c.querySelector('#author-text')?.innerText.trim(), created, created_approx: !!created,
        score: num(c.querySelector('#vote-count-middle')?.innerText), parent_id: null,
        url: `https://www.youtube.com/watch?v=${vid}&lc=${id}`, edited: /edited/i.test(published),
        text: c.querySelector('#content-text')?.innerText.trim() || null,
      };
    };
    const thread = leaf.closest('ytd-comment-thread-renderer');
    const isReply = !!leaf.closest('ytd-comment-replies-renderer');
    const top = isReply && thread ? [...thread.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')].find((x) => !x.closest('ytd-comment-replies-renderer')) : null;
    const comments = [];
    if (top && top !== leaf) comments.push({ ...read(top), saved: false });
    const me = { ...read(leaf), saved: true, selection };
    // Reply ids are "<parent id>.<reply id>", so the parent is known even if its element isn't found.
    if (comments.length) me.parent_id = comments[0].id;
    else if (me.id && me.id.includes('.')) me.parent_id = me.id.split('.')[0];
    comments.push(me);
    if (comments.some((c) => !c.id)) return { error: 'could not read the comment id; open the comment via its timestamp link and retry' };
    show(top || leaf);
    return { source, comments };
  }

  // ---------- Hacker News ----------
  if (host === 'news.ycombinator.com') {
    const row = node.closest('tr.athing');
    if (!row) return { error: 'select text inside a Hacker News comment' };
    const indentOf = (r) => Number(r.querySelector('td.ind')?.getAttribute('indent') || 0);
    const onStory = document.querySelector('.fatitem .onstory a');
    const storyId = onStory ? new URL(onStory.href).searchParams.get('id') : new URL(location.href).searchParams.get('id');
    const titleLink = document.querySelector('.fatitem .titleline > a');
    const source = {
      site: 'hackernews', id: storyId, url: `https://news.ycombinator.com/item?id=${storyId}`,
      title: onStory ? onStory.innerText.trim() : titleLink?.innerText.trim() || document.title,
      author: onStory ? null : document.querySelector('.fatitem .subline .hnuser, .fatitem .subtext .hnuser')?.innerText || null,
    };
    if (titleLink && !onStory && !titleLink.href.startsWith('https://news.ycombinator.com/')) source.link = titleLink.href;
    const read = (r) => {
      const age = r.querySelector('.age')?.getAttribute('title') || '';
      const epoch = Number(age.split(' ')[1]);
      const parentLink = [...r.querySelectorAll('.navs a, .comhead a')].find((a) => a.innerText.trim() === 'parent');
      const pid = parentLink ? new URL(parentLink.href).searchParams.get('id') : null;
      return {
        id: r.id, author: r.querySelector('.hnuser')?.innerText || '[deleted]',
        created: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : age.split(' ')[0] || null,
        score: null, parent_id: pid && pid !== storyId ? pid : null,
        url: `https://news.ycombinator.com/item?id=${r.id}`,
        text: r.querySelector('.commtext')?.innerText.trim() || null,
      };
    };
    // Rendered ancestors: walk back up the flat comment table by indent.
    const chain = [row];
    if (row.classList.contains('comtr')) {
      let want = indentOf(row) - 1;
      for (let r = row.previousElementSibling; r && want >= 0; r = r.previousElementSibling) {
        if (r.classList.contains('comtr') && indentOf(r) === want) { chain.unshift(r); want--; }
      }
    }
    const comments = chain.map((r) => ({ ...read(r), saved: r === row, selection: r === row ? selection : undefined }));
    show(chain[0]);
    return { source, comments };
  }

  // ---------- Any other page ----------
  const url = location.href.split('#')[0];
  const author = document.querySelector('meta[name="author"]')?.content || host;
  return {
    source: { site: 'web', id: await hash(url), url, title: document.title || url, author },
    comments: [{ id: await hash(url + '\n' + selection), author, created: null, score: null, parent_id: null, url, text: selection, saved: true, selection }],
  };
}

function toast(msg, ok) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647, maxWidth: '420px',
    padding: '10px 14px', borderRadius: '8px', font: '14px system-ui, sans-serif', color: '#fff',
    background: ok === true ? '#1b7f3b' : ok === false ? '#b00020' : '#333', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ok === undefined ? 1500 : 5000);
}

function setKey() {
  const key = prompt('Endpoint key for ai-coding-quotes (from ~/.config/ai-coding-quotes/endpoint-key):', '');
  if (key != null && key.trim()) { GM_setValue('token', key.trim()); toast('Key saved', true); }
}

async function saveQuote(target) {
  const token = GM_getValue('token', '');
  if (!token) { setKey(); if (!GM_getValue('token', '')) return; }
  let payload;
  try { payload = await extractQuote(target); } catch (e) { payload = { error: e.message }; }
  if (!payload || payload.error) return toast(`Not saved: ${payload?.error || 'could not read the selection'}`, false);
  toast('Saving quote…');
  GM_xmlhttpRequest({
    method: 'POST', url: ENDPOINT, timeout: 30000,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GM_getValue('token', '')}` },
    data: JSON.stringify(payload),
    onload: (r) => {
      let body = {};
      try { body = JSON.parse(r.responseText); } catch {}
      const who = payload.comments.filter((c) => c.saved).map((c) => c.author).join(', ');
      if (r.status === 200) toast(body.commit ? `Saved ${who} (${body.commit})` : `Already saved: ${who}`, true);
      else toast(`Save failed: ${body.error || 'HTTP ' + r.status}`, false);
    },
    onerror: () => toast('Save failed: network error', false),
    ontimeout: () => toast('Save failed: timed out', false),
  });
}

GM_registerMenuCommand('Save selected quote (Alt+Shift+Q)', () => saveQuote());
GM_registerMenuCommand('Set endpoint key', setKey);
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && e.code === 'KeyQ') { e.preventDefault(); saveQuote(); }
}, true);

// ---------- One-tap ❝ buttons on comments ----------
// Each site: which elements are comments, where the button goes, and how to name the author.
const SITES = {
  reddit: {
    test: /(^|\.)reddit\.com$/,
    comments: 'shreddit-comment',
    // the comment body's own container (light DOM, so the button renders)
    slot: (c) => c.querySelector(`#${c.getAttribute('thingid')}-comment-rtjson-content`)?.parentElement,
    author: (c) => c.getAttribute('author'),
  },
  youtube: {
    test: /(^|\.)youtube\.com$/,
    comments: 'ytd-comment-view-model, ytd-comment-renderer',
    slot: (c) => c.querySelector('#header-author'),
    author: (c) => c.querySelector('#author-text')?.innerText.trim(),
  },
  hackernews: {
    test: /^news\.ycombinator\.com$/,
    comments: 'tr.athing',
    slot: (c) => (c.querySelector('.commtext') ? c.querySelector('.comhead') : null),
    author: (c) => c.querySelector('.hnuser')?.innerText,
  },
};
const site = Object.values(SITES).find((s) => s.test.test(location.hostname));

function addButtons() {
  for (const c of document.querySelectorAll(site.comments)) {
    if (c.dataset.aiQuoteBtn) continue;
    const slot = site.slot(c);
    if (!slot) continue; // body not rendered yet (or a deleted comment); retried on the next change
    c.dataset.aiQuoteBtn = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '❝';
    btn.title = 'Save this comment to ai-coding-quotes';
    Object.assign(btn.style, {
      font: 'bold 14px/1 Georgia, serif', padding: '2px 6px', margin: '0 6px', cursor: 'pointer',
      border: '1px solid currentColor', borderRadius: '6px', background: 'transparent', color: 'inherit', opacity: '0.6',
      float: site === SITES.reddit ? 'right' : 'none',
    });
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.6'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm(`Save ${site.author(c) || 'this'}'s comment to ai-coding-quotes?`)) saveQuote(btn);
    }, true);
    slot.prepend(btn);
  }
}

if (site) {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; addButtons(); });
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}
