/**
 * Page-side probe, kept as a string (no bundler helpers can leak into it).
 * Evaluated as `(<PROBE>)(mode, arg)`; no backticks inside.
 */
export const PROBE_SRC = String.raw`(function (mode, arg) {
  var SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[draggable=true],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"]),h1,h2,h3';
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function trim(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function nameOf(el) {
    var a = el.getAttribute('aria-label'); if (a) return trim(a, 80);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) { var t = lb.split(/\s+/).map(function (i) { var n = document.getElementById(i); return n ? n.textContent : ''; }).join(' '); if (t.trim()) return trim(t, 80); }
    if (el.labels && el.labels.length) { var l = trim(el.labels[0].textContent, 80); if (l) return l; }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' && /^(button|submit|reset)$/i.test(el.type)) return trim(el.value, 80);
    var ph = el.getAttribute('placeholder'); if (ph && (tag === 'input' || tag === 'textarea')) return trim(ph, 80);
    var alt = el.getAttribute('alt'); if (alt) return trim(alt, 80);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return trim(el.getAttribute('title') || el.name || '', 80);
    return trim(el.innerText || el.textContent || el.getAttribute('title') || '', 80);
  }
  function roleOf(el) {
    var r = el.getAttribute('role'); if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'input') {
      var ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
      if (ty === 'file') return 'file';
      return 'textbox';
    }
    if (el.draggable) return 'draggable';
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }
  function describe(el, ref) {
    var t = el.tagName.toLowerCase();
    var o = { ref: ref || '', role: roleOf(el), name: nameOf(el), tag: t };
    if (t === 'input') { o.type = (el.type || 'text').toLowerCase(); }
    var ac = el.getAttribute('autocomplete'); if (ac) o.autocomplete = ac;
    o.attrs = [el.id, el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ');
    if (o.type === 'password' || o.type === 'hidden') { /* never expose value */ }
    else if (t === 'input' || t === 'textarea' || t === 'select') { o.value = trim(el.value, 60); }
    if (el.disabled) o.disabled = true;
    if (el.checked) o.checked = true;
    return o;
  }
  function closestInteractive(el) {
    while (el && el !== document.body) { if (el.matches && el.matches(SEL)) return el; el = el.parentElement; }
    return el;
  }
  if (mode === 'at') { var e = document.elementFromPoint(arg.x, arg.y); e = closestInteractive(e); return e ? describe(e) : null; }
  if (mode === 'focused') { var f = document.activeElement; return f && f !== document.body ? describe(f) : null; }
  if (mode === 'signature') {
    var el0 = arg && document.querySelector('[data-snaglet-ref="' + arg + '"]');
    var rr = el0 ? el0.getBoundingClientRect() : null;
    var txt = document.body ? document.body.innerText : '';
    var h = 0; for (var i = 0; i < txt.length; i++) h = (h * 31 + txt.charCodeAt(i)) | 0;
    return h + ':' + (rr ? Math.round(rr.x) + ',' + Math.round(rr.y) : '');
  }
  if (mode === 'read') {
    var BT = String.fromCharCode(96);
    var root = arg.ref ? document.querySelector('[data-snaglet-ref="' + arg.ref + '"]') : document.body;
    if (!root) return { markdown: '', truncated: false, missing: true };
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, HEAD: 1 };
    function hidden(n) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return true;
      var st = getComputedStyle(n);
      return st.display === 'none' || st.visibility === 'hidden';
    }
    function inline(n) {
      var out = '';
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1 || SKIP[c.tagName.toUpperCase()] || hidden(c)) continue;
        var tg = c.tagName.toLowerCase();
        if (tg === 'br') { out += ' '; continue; }
        var t = inline(c).replace(/\s+/g, ' ');
        if (tg === 'a' && c.getAttribute('href') && t.trim()) {
          var h = c.href || '';
          if (/^javascript:/i.test(h)) out += t; else out += '[' + t.trim() + '](' + h.slice(0, 200) + ')';
        } else if (tg === 'code') { out += t.trim() ? BT + t.trim() + BT : ''; }
        else out += t;
      }
      return out;
    }
    function walk(n, ctx, out) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { var tx = c.nodeValue.replace(/\s+/g, ' '); if (tx.trim()) out.push(tx.trim()); continue; }
        if (c.nodeType !== 1 || SKIP[c.tagName.toUpperCase()] || hidden(c)) continue;
        var tg = c.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tg)) { var ht = inline(c).replace(/\s+/g, ' ').trim(); if (ht) out.push('\n' + '#'.repeat(+tg[1]) + ' ' + ht + '\n'); }
        else if (tg === 'ul' || tg === 'ol') {
          var i = 0;
          for (var li = c.firstElementChild; li; li = li.nextElementSibling) {
            if (li.tagName.toLowerCase() !== 'li' || hidden(li)) continue;
            i++;
            var lt = inline(li).replace(/\s+/g, ' ').trim();
            var line = new Array(ctx + 1).join('  ') + (tg === 'ol' ? i + '. ' : '- ') + lt;
            out.push('\n' + line);
          }
          out.push('\n');
        }
        else if (tg === 'table') {
          var rows = c.querySelectorAll('tr');
          out.push('\n');
          for (var r = 0; r < rows.length && r < 60; r++) {
            var cells = rows[r].children, cs = [];
            for (var k = 0; k < cells.length; k++) cs.push(inline(cells[k]).replace(/\s+/g, ' ').replace(/\|/g, '/').trim());
            out.push('| ' + cs.join(' | ') + ' |\n');
            if (r === 0) out.push('|' + cs.map(function () { return ' --- |'; }).join('') + '\n');
          }
        }
        else if (tg === 'pre') { out.push('\n' + BT + BT + BT + '\n' + (c.textContent || '').slice(0, 2000) + '\n' + BT + BT + BT + '\n'); }
        else if (tg === 'p' || tg === 'blockquote') { var pt = inline(c).replace(/\s+/g, ' ').trim(); if (pt) out.push('\n' + (tg === 'blockquote' ? '> ' : '') + pt + '\n'); }
        else if (tg === 'a' || tg === 'span' || tg === 'b' || tg === 'strong' || tg === 'em' || tg === 'i' || tg === 'button' || tg === 'label' || tg === 'code') {
          var it = inline(c).replace(/\s+/g, ' ').trim();
          if (tg === 'a' && c.getAttribute('href') && it) out.push('[' + it + '](' + (c.href || '').slice(0, 200) + ')'); else if (it) out.push(it);
        }
        else { out.push('\n'); walk(c, ctx, out); out.push('\n'); }
      }
    }
    var parts = [];
    walk(root, 0, parts);
    var md = parts.join(' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    var maxc = arg.max;
    return { markdown: md.slice(0, maxc), truncated: md.length > maxc };
  }
  // collect
  var old = document.querySelectorAll('[data-snaglet-ref]');
  for (var k = 0; k < old.length; k++) old[k].removeAttribute('data-snaglet-ref');
  var max = arg, out = [], truncated = false, seen = new Set();
  function add(el) {
    if (seen.has(el) || !visible(el)) return;
    if (out.length >= max) { truncated = true; return; }
    seen.add(el);
    var ref = 'e' + (out.length + 1);
    el.setAttribute('data-snaglet-ref', ref);
    out.push(describe(el, ref));
  }
  var list = document.querySelectorAll(SEL);
  for (var j = 0; j < list.length; j++) add(list[j]);
  if (out.length < max) {
    var all = document.body ? document.body.querySelectorAll('div,span,li,td,img,svg') : [];
    var lim = Math.min(all.length, 4000);
    for (var m = 0; m < lim && out.length < max; m++) {
      var n = all[m];
      if (!seen.has(n) && getComputedStyle(n).cursor === 'pointer' && !n.parentElement.closest('[data-snaglet-ref]')) add(n);
    }
  }
  return { elements: out, truncated: truncated };
})`;
