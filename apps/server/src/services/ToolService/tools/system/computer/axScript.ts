/**
 * JXA over the macOS accessibility API (System Events wraps AXUIElement).
 * Run via `osascript -l JavaScript -e <script> <action> <json-args>`.
 *   front : {ok, app, title}
 *   focus : {ok, app, role, subrole, label}   (focused element of the frontmost app)
 *   look  : {ok, app, title, elements:[{path,role,subrole,label,value,x,y,w,h}], truncated}
 *   act   : {ok}  args {path, action: press|set_value|select, value?}
 * Element paths are child indices from the front window. Never throws.
 */
export const AX_JXA = `
ObjC.import('ApplicationServices');
var SE = Application('System Events');
// System Events calls are slow on large WebKit trees. Return a partial tree before
// the host's 15-second timeout kills osascript and discards every element.
var deadline = Date.now() + 7000; var timedOut = false;
function attr(el, name) { try { return el.attributes.byName(name).value(); } catch (e) { return null; } }
function front() {
  var p = SE.processes.whose({ frontmost: true })[0];
  return p;
}
function winOf(p) { try { return p.windows[0]; } catch (e) { return null; } }
// Some attributes come back as object specifiers (typeof 'function', e.g. a tab group's AXValue
// pointing at its selected tab); String() on those throws "Can't convert types". Never let one
// odd element fail the whole look.
function text(v) {
  if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') return '';
  try { return String(v); } catch (e) { return ''; }
}
function info(el, path) {
  var pos = null, size = null;
  try { pos = el.position(); size = el.size(); } catch (e) {}
  var label = text(attr(el, 'AXTitle')) || text(attr(el, 'AXDescription')) || text(attr(el, 'AXPlaceholderValue'));
  return {
    path: path, role: text(attr(el, 'AXRole')), subrole: text(attr(el, 'AXSubrole')), label: label,
    value: text(attr(el, 'AXValue')).slice(0, 200),
    x: pos ? pos[0] : 0, y: pos ? pos[1] : 0, w: size ? size[0] : 0, h: size ? size[1] : 0
  };
}
function walk(el, path, depth, out, max, maxDepth) {
  if (Date.now() >= deadline) { timedOut = true; return; }
  if (out.length >= max || depth > maxDepth) return;
  var kids = [];
  try { kids = el.uiElements(); } catch (e) {}
  for (var i = 0; i < kids.length && out.length < max && Date.now() < deadline; i++) {
    var p = path.concat([i]);
    out.push(info(kids[i], p));
    walk(kids[i], p, depth + 1, out, max, maxDepth);
  }
}
function run(argv) {
  try {
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, error: 'accessibility_permission_missing' });
    var action = argv[0], a = JSON.parse(argv[1] || '{}');
    var p = front();
    var app = p.name();
    var w = winOf(p), title = '';
    try { title = w ? w.name() : ''; } catch (e) {}
    if (action === 'front') return JSON.stringify({ ok: true, app: app, title: title });
    if (action === 'focus') {
      var f = attr(p, 'AXFocusedUIElement');
      var fi = f ? info(f, []) : { role: '', subrole: '', label: '' };
      return JSON.stringify({ ok: true, app: app, role: fi.role, subrole: fi.subrole, label: fi.label });
    }
    if (action === 'look') {
      var out = [];
      if (w) walk(w, [], 1, out, (a.max || 150) + 1, a.maxDepth || 8);
      var truncated = timedOut || Date.now() >= deadline || out.length > (a.max || 150);
      return JSON.stringify({ ok: true, app: app, title: title, elements: out.slice(0, a.max || 150), truncated: truncated });
    }
    if (action === 'act') {
      var el = w;
      for (var i = 0; i < a.path.length; i++) el = el.uiElements()[a.path[i]];
      if (a.action === 'press') el.actions.byName('AXPress').perform();
      else if (a.action === 'set_value') el.value = a.value;
      else if (a.action === 'select') el.selected = true;
      else return JSON.stringify({ ok: false, error: 'unknown_action' });
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ ok: false, error: 'unknown_action' });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'script_error: ' + e });
  }
}
`;
