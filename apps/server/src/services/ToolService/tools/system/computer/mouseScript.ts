/**
 * JXA run via `osascript -l JavaScript -e <script> <action> <x> <y> <button>`.
 * Posts CGEvent mouse events. Prints JSON: {ok:true} or {ok:false,error}.
 */
export const MOUSE_JXA = `
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
function run(argv) {
  if (!$.AXIsProcessTrusted()) {
    return JSON.stringify({ ok: false, error: 'accessibility_permission_missing' });
  }
  var action = argv[0], x = parseFloat(argv[1]), y = parseFloat(argv[2]), btn = argv[3] || 'left';
  var b = $.CGDisplayBounds($.CGMainDisplayID());
  if (!(x >= 0 && y >= 0 && x < b.size.width && y < b.size.height)) {
    return JSON.stringify({ ok: false, error: 'out_of_bounds', width: b.size.width, height: b.size.height });
  }
  var p = $.CGPointMake(x, y);
  var right = btn === 'right';
  function post(type, button) {
    var ev = $.CGEventCreateMouseEvent(null, type, p, button);
    $.CGEventPost($.kCGHIDEventTap, ev);
  }
  post($.kCGEventMouseMoved, 0);
  if (action === 'click') {
    post(right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown, right ? 1 : 0);
    post(right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp, right ? 1 : 0);
  }
  return JSON.stringify({ ok: true });
}
`;
