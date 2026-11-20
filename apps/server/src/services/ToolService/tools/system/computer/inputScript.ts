/**
 * JXA for keyboard, drag and scroll. Run via
 * `osascript -l JavaScript -e <script> <action> <json-args>`.
 * Prints JSON: {ok:true} or {ok:false,error}. Never throws.
 */
export const INPUT_JXA = `
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
ObjC.import('Foundation');
var KEYCODES = {
  a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,
  '1':18,'2':19,'3':20,'4':21,'6':22,'5':23,'=':24,'9':25,'7':26,'-':27,'8':28,'0':29,
  ']':30,o:31,u:32,'[':33,i:34,p:35,enter:36,'return':36,l:37,j:38,"'":39,k:40,';':41,
  '\\\\':42,',':43,'/':44,n:45,m:46,'.':47,tab:48,space:49,'\`':50,backspace:51,delete:51,
  escape:53,esc:53,left:123,right:124,down:125,up:126,home:115,end:119,pageup:116,pagedown:121,
  f1:122,f2:120,f3:99,f4:118,f5:96,f6:97,f7:98,f8:100,f9:101,f10:109,f11:103,f12:111
};
// Not libc usleep: it is no longer bridged through Foundation on macOS 26, so it is undefined there.
function sleep(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }
function mouse(type, x, y, button) {
  var ev = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  $.CGEventPost($.kCGHIDEventTap, ev);
}
function run(argv) {
  try {
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, error: 'accessibility_permission_missing' });
    var action = argv[0], a = JSON.parse(argv[1] || '{}');
    if (action === 'drag') {
      var steps = Math.max(2, Math.min(60, a.steps || 20));
      mouse($.kCGEventMouseMoved, a.fx, a.fy, 0);
      sleep(40);
      mouse($.kCGEventLeftMouseDown, a.fx, a.fy, 0);
      for (var i = 1; i <= steps; i++) {
        var x = a.fx + (a.tx - a.fx) * i / steps, y = a.fy + (a.ty - a.fy) * i / steps;
        mouse($.kCGEventLeftMouseDragged, x, y, 0);
        sleep(12);
      }
      mouse($.kCGEventLeftMouseUp, a.tx, a.ty, 0);
      return JSON.stringify({ ok: true });
    }
    if (action === 'scroll') {
      if (typeof a.x === 'number' && typeof a.y === 'number') { mouse($.kCGEventMouseMoved, a.x, a.y, 0); sleep(30); }
      var ev = $.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitLine, 1, Math.round(-a.dy), 0, 0);
      $.CGEventPost($.kCGHIDEventTap, ev);
      return JSON.stringify({ ok: true });
    }
    if (action === 'type') {
      Application('System Events').keystroke(a.text);
      return JSON.stringify({ ok: true });
    }
    if (action === 'key') {
      var flags = 0;
      var parts = String(a.combo).toLowerCase().split('+').map(function (s) { return s.trim(); });
      var key = parts.pop();
      parts.forEach(function (m) {
        if (m === 'cmd' || m === 'command' || m === 'meta') flags |= 0x100000;
        else if (m === 'shift') flags |= 0x20000;
        else if (m === 'alt' || m === 'option' || m === 'opt') flags |= 0x80000;
        else if (m === 'ctrl' || m === 'control') flags |= 0x40000;
      });
      var code = KEYCODES[key];
      if (code === undefined) return JSON.stringify({ ok: false, error: 'unknown_key:' + key });
      [true, false].forEach(function (down) {
        var e = $.CGEventCreateKeyboardEvent(null, code, down);
        $.CGEventSetFlags(e, flags);
        $.CGEventPost($.kCGHIDEventTap, e);
        sleep(15);
      });
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ ok: false, error: 'unknown_action' });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'script_error: ' + e });
  }
}
`;
