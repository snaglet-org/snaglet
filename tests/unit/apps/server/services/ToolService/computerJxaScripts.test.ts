import { INPUT_JXA } from '@server/services/ToolService/tools/system/computer/inputScript';
import { MOUSE_JXA } from '@server/services/ToolService/tools/system/computer/mouseScript';
import { AX_JXA } from '@server/services/ToolService/tools/system/computer/axScript';
import { POINTER_JXA } from '@server/services/ToolService/tools/system/computer/pointerScript';

describe('computer JXA scripts', () => {
  // libc usleep is not bridged on macOS 26: `$.usleep` is undefined, so key/drag/scroll must not use it.
  it.each([
    ['INPUT_JXA', INPUT_JXA],
    ['MOUSE_JXA', MOUSE_JXA],
    ['AX_JXA', AX_JXA],
    ['POINTER_JXA', POINTER_JXA],
  ])('%s does not call $.usleep', (_name, script) => {
    expect(script).not.toMatch(/\$\.usleep\b/);
  });

  it('AX_JXA look survives an element whose value is an object specifier', () => {
    // Real Snaglet sidebar: a tab group's AXValue is a specifier (typeof 'function') and String() on
    // it throws "Can't convert types", which must not fail the whole look.
    const specifier = Object.assign(() => undefined, {
      toString() {
        throw new Error("Can't convert types.");
      },
    });
    const el = (attrs: Record<string, unknown>, kids: unknown[] = []) => ({
      attributes: {
        byName: (n: string) => ({
          value: () => {
            if (!(n in attrs)) throw new Error('no attr');
            return attrs[n];
          },
        }),
      },
      position: () => [10, 20],
      size: () => [30, 40],
      uiElements: () => kids,
    });
    const tabs = el({ AXRole: 'AXTabGroup', AXTitle: 'Sidebar views', AXValue: specifier });
    const button = el({ AXRole: 'AXButton', AXTitle: 'New thread', AXValue: 3 });
    const win = Object.assign(el({}, [tabs, button]), { name: () => 'Snaglet' });
    const proc = Object.assign(el({}), { name: () => 'desktop', windows: [win] });
    const dollar = String.fromCharCode(36); // the JXA bridge global is named with a dollar sign
    const run = new Function('ObjC', dollar, 'Application', AX_JXA + '; return run;')(
      { import: () => undefined },
      { AXIsProcessTrusted: () => true },
      () => ({ processes: { whose: () => [proc] } })
    ) as (argv: string[]) => string;

    const out = JSON.parse(run(['look', '{}']));
    expect(out.ok).toBe(true);
    expect(out.elements).toEqual([
      expect.objectContaining({ role: 'AXTabGroup', label: 'Sidebar views', value: '' }),
      expect.objectContaining({ role: 'AXButton', label: 'New thread', value: '3' }),
    ]);
  });

  it('INPUT_JXA sleeps through Foundation', () => {
    expect(INPUT_JXA).toContain("ObjC.import('Foundation')");
    expect(INPUT_JXA).toContain('$.NSThread.sleepForTimeInterval(');
  });
});
