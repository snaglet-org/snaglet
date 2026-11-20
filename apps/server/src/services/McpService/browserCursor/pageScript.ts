/**
 * The page-side agent cursor, installed by BrowserController into every page of
 * the agent's browser (as a page init script). Plain browser JS kept as a string so it
 * ships inside the server bundle. No backticks or template placeholders in it.
 *
 * Reads `window.__snagletAgentCursor = { name, avatar, ringColor, theme?: { background, text, border } }` (set just
 * before this runs); `avatar` is a data:image/svg+xml;base64 URL of the agent's neutral-face flower, `avatars` is an optional map { neutral, stumped, thinking, curious } of such URLs (`avatarStumped` kept as the stumped face). Exposes `window.__snagletAgentCursorMove(x, y, state, label)`, which the
 * controller calls explicitly; glides, blooms on state 'click', hides after idle, and `window.__snagletAgentCursorEmotion(name, ttlMs)`, which shows that emotion's face for ttlMs then restores neutral (state 'error' uses it with 'stumped' for 3.5s).
 */
export const BROWSER_CURSOR_PAGE_SCRIPT = String.raw`
(function () {
  if (window.top !== window || window.__snagletAgentCursorInstalled) return;
  window.__snagletAgentCursorInstalled = true;
  var IDLE_MS = 8000, GLIDE_MS = 300;
  var STUMPED_MS = 3500;
  var host, wrap, tag, bloom, svgBox, hideTimer, lastKey = '', faceImg = null, emoTimer = 0, emoName = '', emoUntil = 0;
  var FACES = ['neutral', 'stumped', 'thinking', 'curious'];

  function identity() {
    var id = window.__snagletAgentCursor || {};
    var th = id.theme, hex = /^#[0-9a-f]{6}$/i;
    var theme = th && hex.test(th.background) && hex.test(th.text) && hex.test(th.border)
      ? { background: th.background, text: th.text, border: th.border } : null;
    var av = typeof id.avatar === 'string' && id.avatar.indexOf('data:image/svg+xml;base64,') === 0 && id.avatar.length < 40000 ? id.avatar : '';
    var okUrl = function (u) { return typeof u === 'string' && u.indexOf('data:image/svg+xml;base64,') === 0 && u.length < 40000 ? u : ''; };
    var faces = {};
    for (var i = 0; i < FACES.length; i++) { var u = okUrl(id.avatars && id.avatars[FACES[i]]); if (u) faces[FACES[i]] = u; }
    if (!faces.neutral && av) faces.neutral = av;
    if (!faces.stumped) { var legacy = okUrl(id.avatarStumped); if (legacy) faces.stumped = legacy; }
    var ring = typeof id.ringColor === 'string' && /^#[0-9a-f]{6}$/i.test(id.ringColor) ? id.ringColor : '';
    return { avatar: av || faces.neutral || '', faces: faces, ring: ring, color: ring || (/^#[0-9a-f]{6}$/i.test(id.color) ? id.color : '#8a8f98'), name: id.name || 'Agent', theme: theme };
  }
  function ensure() {
    if (host && host.isConnected) return true;
    var root = document.documentElement || document.body;
    if (!root) return false;
    host = document.createElement('div');
    host.setAttribute('data-snaglet-agent-cursor', '');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;left:0;top:0;opacity:0;pointer-events:none;transition:transform ' + GLIDE_MS + 'ms cubic-bezier(.22,.8,.3,1),opacity 200ms;will-change:transform;';
    svgBox = document.createElement('div');
    svgBox.style.cssText = 'position:absolute;left:-28px;top:-28px;width:56px;height:56px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));';
    bloom = document.createElement('div');
    bloom.style.cssText = 'position:absolute;left:-40px;top:-40px;width:80px;height:80px;box-sizing:border-box;border-radius:50%;opacity:0;pointer-events:none;';
    tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;left:30px;top:16px;width:max-content;max-width:300px;padding:2px 8px;border-radius:10px;font:600 11px/15px system-ui,sans-serif;color:#fff;white-space:normal;overflow-wrap:anywhere;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.3);';
    wrap.appendChild(bloom); wrap.appendChild(svgBox); wrap.appendChild(tag);
    host.appendChild(wrap);
    root.appendChild(host);
    return true;
  }
  function paint() {
    var id = identity(), key = id.avatar + '|' + id.ring + '|' + id.name + '|' + (id.theme ? id.theme.background + id.theme.text + id.theme.border : '');
    if (key === lastKey) return;
    lastKey = key;
    svgBox.textContent = '';
    faceImg = null;
    if (id.avatar) {
      var img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = emoUntil > Date.now() && id.faces[emoName] ? id.faces[emoName] : id.avatar;
      faceImg = img;
      img.style.cssText = 'display:block;width:56px;height:56px;pointer-events:none;';
      svgBox.appendChild(img);
    } else {
      var dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;left:21px;top:21px;width:14px;height:14px;border-radius:50%;background:' + id.color + ';';
      svgBox.appendChild(dot);
    }
    tag.textContent = id.name;
    if (id.theme) {
      tag.style.background = id.theme.background;
      tag.style.color = id.theme.text;
      tag.style.border = '1px solid ' + id.theme.border;
    } else {
      tag.style.background = id.color;
      tag.style.color = '#fff';
      tag.style.border = '0';
    }
    bloom.style.border = '2px solid ' + id.color;
  }
  // Shows an emotion's face for ttl ms, then restores neutral; 'neutral' (or ttl <= 0) restores at
  // once. Unknown names and faces without a URL are ignored. A later call restarts the timer; moves
  // leave the face alone. Error moves use this with 'stumped' for STUMPED_MS.
  function restore() {
    clearTimeout(emoTimer);
    emoUntil = 0; emoName = '';
    var cur = identity();
    if (faceImg && cur.avatar) faceImg.src = cur.avatar;
  }
  function setEmotion(name, ttl) {
    if (typeof name !== 'string' || FACES.indexOf(name) < 0) return;
    ttl = Number(ttl);
    if (!isFinite(ttl)) return;
    if (name === 'neutral' || ttl <= 0) { restore(); return; }
    if (!ensure()) return;
    paint();
    var id = identity();
    if (!id.faces[name] || !faceImg) return;
    clearTimeout(emoTimer);
    emoName = name;
    emoUntil = Date.now() + Math.min(ttl, 60000);
    faceImg.src = id.faces[name];
    emoTimer = setTimeout(restore, Math.min(ttl, 60000));
  }
  function show(x, y) {
    if (!ensure()) return;
    paint();
    var first = wrap.style.opacity === '0';
    if (first) { wrap.style.transition = 'opacity 200ms'; }
    else { wrap.style.transition = 'transform ' + GLIDE_MS + 'ms cubic-bezier(.22,.8,.3,1),opacity 200ms'; }
    wrap.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    wrap.style.opacity = '1';
    if (first) { void wrap.offsetWidth; wrap.style.transition = 'transform ' + GLIDE_MS + 'ms cubic-bezier(.22,.8,.3,1),opacity 200ms'; }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (wrap) wrap.style.opacity = '0'; }, IDLE_MS);
  }
  function burst() {
    if (!bloom) return;
    try {
      var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (still) return;
      // Ring grows from radius 16 to 40 (80px box) while fading out.
      bloom.animate(
        [{ transform: 'scale(.4)', opacity: 0.9 }, { transform: 'scale(1)', opacity: 0 }],
        { duration: 550, easing: 'ease-out' }
      );
      svgBox.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.85)', offset: 0.3 }, { transform: 'scale(1)' }],
        { duration: 350, easing: 'ease-out' }
      );
    } catch (e) {}
  }
  // Driven explicitly by the controller. Real mouse events are NOT followed: CDP input is
  // indistinguishable from the user's own pointer, which must never move an agent's flower.
  window.__snagletAgentCursorMove = function (x, y, state, label) {
    x = Number(x); y = Number(y);
    if (!isFinite(x) || !isFinite(y)) return;
    show(x, y);
    if (tag) {
      var id = identity();
      tag.textContent = label ? id.name + ': ' + String(label).slice(0, 600) : id.name;
    }
    if (state === 'click') burst();
    if (state === 'error') setEmotion('stumped', STUMPED_MS);
  };
  window.__snagletAgentCursorEmotion = setEmotion;
})();
`;
