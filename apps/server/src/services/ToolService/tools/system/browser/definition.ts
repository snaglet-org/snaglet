import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  MAX_BATCH_HOLD_MS,
  MAX_HOLD_KEYS,
  MAX_HOLD_MS,
} from '@server/services/BrowserController/keyHold';

const definition: BuiltinToolDefinition = {
  id: 'browser',
  name: 'Browser',
  description:
    'Drive a real browser (Snaglet-owned signed-in profile "main", or profile "temp" = isolated, signed out). Flow: open(url) -> snapshot (refs e1..eN, valid until next snapshot/navigation) -> click/type/drag by ref. You only see tabs you opened. The user is asked to allow first use. Never type passwords/card numbers: the user signs in via the profile sign-in flow. For send/delete/buy/confirm-style controls the tool returns needsApproval. Before anything that sends, deletes or buys, and before submitting, posting or anything else hard to undo, ask in chat (the `ask` tool) and wait for the user\'s answer; the question appears next to your cursor and the user can answer by keyboard. Only then repeat with approved:true.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['browser', 'web', 'page', 'click', 'navigate', 'screenshot', 'playwright', 'website'],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: [
          'profiles',
          'open',
          'tabs',
          'switch',
          'show',
          'close',
          'navigate',
          'snapshot',
          'read',
          'find',
          'screenshot',
          'click',
          'hover',
          'drag',
          'mouse',
          'type',
          'fill',
          'clear',
          'check',
          'uncheck',
          'press',
          'select',
          'upload',
          'scroll',
          'wait',
          'dialog',
          'downloads',
          'console',
          'network',
          'handoff',
          'batch',
          'pdf',
          'resize',
          'trace',
        ],
        description:
          'open: new tab (url, profile?). tabs/switch/show/close: your tabs (tab); close with profile releases that browser. navigate: url or to=back|forward|reload. snapshot: outline with refs; read: page text as markdown (ref?); find: text->refs. click/hover: ref or x,y. drag: from,to or path. mouse: action down|move|up|wheel. type: appends, fill: replaces, clear, check/uncheck: ref. press: key taps; key or keys + hold_ms holds them down together. select: ref,option. upload: ref,files. scroll: dy. wait: selector|text|ms. dialog: action accept|dismiss (omit to peek). console/network: recent errors (clear?). handoff: message for the user to finish a step (login, 2FA, CAPTCHA). batch: steps[] run in order. pdf, resize (width,height), trace (action start|stop)',
      },
      url: { type: 'string', description: 'open/navigate: http(s) URL' },
      profile: {
        type: 'string',
        description:
          'open: profile id (default "main"; "temp" = isolated, signed out). close: release it',
      },
      tab: { type: 'string', description: 'Tab id (default: your active tab)' },
      to: { description: 'navigate: back|forward|reload. drag: end ref string or {x,y}' },
      ref: { type: 'string', description: 'Element ref from the last snapshot' },
      frame: {
        type: 'string',
        description:
          'iframe name, url substring or index; use the same frame for snapshot and the ref ops',
      },
      x: { type: 'number', description: 'Viewport x (alternative to ref)' },
      y: { type: 'number', description: 'Viewport y' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click' },
      double: { type: 'boolean', description: 'click: double-click' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] },
        description: 'click/hover/drag',
      },
      from: { description: 'drag start: ref string or {x,y}' },
      path: {
        type: 'array',
        items: { type: 'object' },
        description: 'drag: waypoints [{x,y}] (max 50)',
      },
      steps: {
        type: 'array',
        items: { type: 'object' },
        description: `batch: up to 15 {op,...} steps on one tab; holds total max ${MAX_BATCH_HOLD_MS} ms; stops at first failure or needsApproval. No nesting/open/close/handoff.`,
      },
      message: {
        type: 'string',
        description: 'handoff: what the user should do in the browser window',
      },
      text: {
        type: 'string',
        description: 'type/fill: text (never passwords/secrets). find/wait: text to look for',
      },
      submit: { type: 'boolean', description: 'type: press Enter afterward' },
      key: { type: 'string', description: 'press: e.g. "Enter", "Control+a"' },
      keys: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_HOLD_KEYS,
        description: 'press: keys held down together with hold_ms, e.g. ["w","d"]',
      },
      hold_ms: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_HOLD_MS,
        description: 'press: hold key/keys down this long, then release (not Tab)',
      },
      option: { type: 'string', description: 'select: option label or value' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'upload: paths inside your project folder',
      },
      dx: { type: 'number', description: 'scroll/mouse wheel: horizontal px' },
      dy: { type: 'number', description: 'scroll/mouse wheel: vertical px (positive = down)' },
      selector: { type: 'string', description: 'wait: CSS selector to become visible' },
      ms: { type: 'number', description: 'wait: milliseconds (max 15000)' },
      action: {
        type: 'string',
        description: 'dialog: accept|dismiss. mouse: down|move|up|wheel. trace: start|stop',
      },
      width: { type: 'number', description: 'resize' },
      height: { type: 'number', description: 'resize' },
      scale: { type: 'number', description: 'resize: deviceScaleFactor 1-3' },
      level: { type: 'string', enum: ['error', 'warn', 'log'], description: 'console filter' },
      clear: { type: 'boolean', description: 'console/network: clear after reading' },
      force: {
        type: 'boolean',
        description: 'close profile: even if others use it (only if the user asked)',
      },
      approved: {
        type: 'boolean',
        description:
          'Set true ONLY after the user said yes in chat to a needsApproval prompt. Never on your own.',
      },
      reason: { type: 'string', description: 'One line: why (shown to the user)' },
    },
  },
  sort_order: 76,
};

export default definition;
