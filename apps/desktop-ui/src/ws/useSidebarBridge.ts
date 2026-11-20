import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  UI_EVENT_CHANNEL,
  clampSidebarScrollDuration,
  isSidebarTabId,
  parseSidebarTarget,
  type SidebarTabId,
  type UiSidebarRequestEvent,
  type UiSidebarResponseEvent,
} from '@snaglet/shared/types';
import { requestMountedDisclosure } from './sidebarMounted';
import { requestSidebarDisclosure } from './sidebarDisclosure';
import { inspectSidebar } from './inspectSidebar';
import { requestSidebarScroll, type SidebarScrollResult } from './sidebarScroll';
import { useWs } from './useWs';

interface Args {
  width?: number;
  setWidth?: (width: number) => void;
  panelRef?: RefObject<HTMLDivElement | null>;
  open: boolean;
  activeTab: SidebarTabId;
  setOpen: (open: boolean) => void;
  setActiveTab: (tab: SidebarTabId) => void;
}

/** Ack from an effect after the Dashboard has committed, never from the setter. */
export function useSidebarBridge(args: Args): void {
  const { addMessageListener, send } = useWs();
  const argsRef = useRef(args);
  argsRef.current = args;
  const [pending, setPending] = useState<
    Array<{
      requestId: string;
      inspect?: boolean;
      disclosure?: { target: string; expanded: boolean };
      scroll?: SidebarScrollResult;
      error?: UiSidebarResponseEvent['error'];
    }>
  >([]);

  useEffect(
    () =>
      addMessageListener((message) => {
        if (message.channel !== UI_EVENT_CHANNEL || message.type !== 'ui.sidebar_request') return;
        const event = message.payload as UiSidebarRequestEvent | undefined;
        if (!event || typeof event.requestId !== 'string') return;
        const { command } = event;
        let error: UiSidebarResponseEvent['error'];
        const current = argsRef.current;
        if (
          !command ||
          ![
            'open',
            'close',
            'status',
            'inspect',
            'expand',
            'collapse',
            'resize',
            'scroll',
          ].includes(command.op) ||
          (command.op === 'scroll'
            ? (command.target === undefined) === (command.to === undefined) ||
              (command.to !== undefined && command.to !== 'top' && command.to !== 'bottom') ||
              (command.target !== undefined &&
                (typeof command.target !== 'string' || !parseSidebarTarget(command.target))) ||
              (command.duration_ms !== undefined &&
                (typeof command.duration_ms !== 'number' || !Number.isFinite(command.duration_ms)))
            : command.to !== undefined || command.duration_ms !== undefined) ||
          (command.op === 'resize'
            ? typeof command.width_px !== 'number' ||
              !Number.isFinite(command.width_px) ||
              !current.setWidth
            : command.width_px !== undefined) ||
          (command.tab !== undefined && (command.op !== 'open' || !isSidebarTabId(command.tab))) ||
          (command.op === 'scroll'
            ? false
            : command.op === 'expand' || command.op === 'collapse'
              ? typeof command.target !== 'string' || !command.target.trim()
              : command.target !== undefined)
        ) {
          error = 'invalid_command';
        } else if (command.op === 'scroll') {
          if (!current.open) error = 'sidebar_closed';
          else if (
            command.target !== undefined &&
            parseSidebarTarget(command.target)!.tab !== current.activeTab
          )
            error = 'wrong_tab';
          else {
            void requestSidebarScroll(current.panelRef?.current ?? null, current.activeTab, {
              to: command.to,
              target: command.target,
              duration_ms: clampSidebarScrollDuration(command.duration_ms),
            }).then((result) => {
              setPending((requests) => [
                ...requests,
                {
                  requestId: event.requestId,
                  ...('error' in result ? { error: result.error } : { scroll: result }),
                },
              ]);
            });
            return;
          }
        } else if (command.op === 'expand' || command.op === 'collapse') {
          // A missing target parses to null, like any other malformed one.
          const targetText = command.target ?? '';
          const target = parseSidebarTarget(targetText);
          if (!current.open) error = 'sidebar_closed';
          else if (!target) error = 'invalid_command';
          else if (target.tab !== current.activeTab) error = 'wrong_tab';
          else if (
            !(current.activeTab === 'library' && target.kind === 'container') &&
            !(
              ['calendar', 'providers', 'tools', 'skills', 'automations'].includes(
                current.activeTab
              ) && target.kind === 'mounted'
            )
          )
            error = 'unsupported_target';
          else {
            const request =
              target.kind === 'mounted'
                ? requestMountedDisclosure(
                    current.panelRef?.current ?? null,
                    current.activeTab,
                    targetText,
                    command.op === 'expand'
                  )
                : requestSidebarDisclosure(
                    current.panelRef?.current ?? null,
                    target.id,
                    command.op === 'expand'
                  );
            void request.then((result) => {
              setPending((requests) => [
                ...requests,
                {
                  requestId: event.requestId,
                  ...('error' in result
                    ? { error: result.error }
                    : { disclosure: { target: command.target!, expanded: result.expanded } }),
                },
              ]);
            });
            return;
          }
        } else {
          if (command.op === 'resize') current.setWidth?.(command.width_px!);
          else if (command.op === 'open') {
            if (command.tab) current.setActiveTab(command.tab);
            current.setOpen(true);
          } else if (command.op === 'close') current.setOpen(false);
        }
        setPending((requests) => [
          ...requests,
          {
            requestId: event.requestId,
            inspect: command?.op === 'inspect',
            ...(error ? { error } : {}),
          },
        ]);
      }),
    [addMessageListener]
  );

  useEffect(() => {
    if (!pending.length) return;
    for (const request of pending) {
      send({
        type: 'ui.sidebar_response',
        channel: UI_EVENT_CHANNEL,
        payload: {
          requestId: request.requestId,
          ...(request.error ? { error: request.error } : {}),
          state: {
            ...(args.width !== undefined ? { width_px: args.width } : {}),
            open: args.open,
            active_tab: args.activeTab,
            ...(request.disclosure ?? {}),
            ...(request.scroll ?? {}),
            ...(request.inspect && !request.error
              ? {
                  detail: inspectSidebar(args.panelRef?.current ?? null, args.open, args.activeTab),
                }
              : {}),
          },
        },
      });
    }
    setPending([]);
  }, [pending, args.open, args.activeTab, args.width, send]);
}
