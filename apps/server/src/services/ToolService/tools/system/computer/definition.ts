import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'computer',
  name: 'Computer',
  description:
    "Control the real macOS desktop (look, click, drag, type, key, scroll, accessibility actions). Use browser tools for web pages; use computer only for the desktop. Take the cursor (op:claim) only when you must; if it is busy, do other work and retry later. The user is asked to allow it first. Never type into password/secret fields. For send/delete/buy/confirm-style controls the tool returns needsApproval. Before anything that sends, deletes or buys, and before submitting, posting or anything else hard to undo, ask in chat (the `ask` tool) and wait for the user's answer; the question appears next to your cursor and the user can answer by keyboard. Only then repeat with approved:true. If the user moves their mouse while you hold the cursor, input ops return {ok:false, interrupted:true} and the cursor is released: ask before taking it again.",
  type: 'builtin',
  tier: 'standard',
  keywords: ['computer', 'desktop', 'cursor', 'mouse', 'click', 'screen', 'screenshot', 'macos'],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: [
          'claim',
          'release',
          'status',
          'screenshot',
          'look',
          'act',
          'move',
          'click',
          'drag',
          'scroll',
          'type',
          'key',
          'wait',
          'point',
          'hide',
        ],
        description:
          'claim/release the shared cursor; status; screenshot; look = accessibility tree of the frontmost window (element ids, labels, bounds); act = accessibility action on an element id (needs the claim); move/click/drag/scroll/type/key need the claim; wait = pause (max 10s); point = show your flower at x,y with reason as its label, no claim, no real input (flag UI while another agent holds the cursor); hide = remove your flower from the screen now (no claim)',
      },
      target: {
        type: 'string',
        description:
          'Element id from the last look (e.g. "e12"). Alternative to x/y for move/click; required for act; optional for type/key (checked for secret fields).',
      },
      x: {
        type: 'number',
        description: 'move/click/scroll/point: screen x in points (top-left origin)',
      },
      y: {
        type: 'number',
        description: 'move/click/scroll/point: screen y in points (top-left origin)',
      },
      glide_ms: {
        type: 'number',
        description:
          'point only: glide to x,y over this many ms with linear easing (for scripted, continuous motion). Omit for the default ease.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right'],
        default: 'left',
        description: 'click only',
      },
      from: { description: 'drag start: element id string or {x,y}' },
      to: { description: 'drag end: element id string or {x,y}' },
      dy: { type: 'number', description: 'scroll: lines; positive scrolls down, negative up' },
      text: { type: 'string', description: 'type: text to type (never password/secret fields)' },
      combo: { type: 'string', description: 'key: e.g. "cmd+s", "enter", "escape", "cmd+shift+4"' },
      ms: { type: 'number', description: 'wait: milliseconds, capped at 10000' },
      action: { type: 'string', enum: ['press', 'set_value', 'select'], description: 'act only' },
      value: { type: 'string', description: 'act set_value: the new value' },
      approved: {
        type: 'boolean',
        description:
          'Set true ONLY after the user said yes in chat to a needsApproval prompt. Never set it on your own.',
      },
      reason: { type: 'string', description: 'One line shown beside your cursor' },
    },
  },
  sort_order: 75,
};

export default definition;
