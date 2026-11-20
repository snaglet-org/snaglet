/**
 * JXA run via `osascript -l JavaScript -e <script>`. Reads the real pointer
 * location (main-display points, top-left origin). Prints JSON: {ok:true,x,y}.
 */
export const POINTER_JXA = `
ObjC.import('CoreGraphics');
function run() {
  var p = $.CGEventGetLocation($.CGEventCreate($()));
  return JSON.stringify({ ok: true, x: p.x, y: p.y });
}
`;
