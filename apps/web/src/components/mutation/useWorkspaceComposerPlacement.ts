import type { WorkspaceBridgeRect } from "@t3tools/shared/mutationWorkspace";
import { useCallback, useLayoutEffect, useState, type CSSProperties } from "react";

import { observeResize } from "../../lib/observeResize";

function rectsEqual(left: WorkspaceBridgeRect | null, right: WorkspaceBridgeRect | null) {
  if (left === null || right === null) return left === right;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function roundRect(rect: WorkspaceBridgeRect | null): WorkspaceBridgeRect | null {
  return rect === null
    ? null
    : {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
}

export interface WorkspaceComposerPlacement {
  /** Whether the composer sits in the page's `data-t3-composer` slot. */
  readonly slotted: boolean;
  /** Classes and position for ChatView's composer overlay; null outside a workspace. */
  readonly overlayClassName: string | null;
  readonly overlayStyle: CSSProperties | undefined;
  /** The composer's own height, which the page sizes its slot to. */
  readonly composerHeight: number;
  /** Space the docked composer takes along the bottom; the frame ends above it. */
  readonly dockHeight: number;
  readonly onComposerSlotChange: (rect: WorkspaceBridgeRect | null) => void;
}

/**
 * Places ChatView's existing composer overlay inside a workspace: over the
 * page's slot when it has one (the slot rect is relative to the frame, which
 * shares the overlay's containing block), else docked along the bottom.
 * The composer is never remounted, so drafts, focus, and uploads carry over.
 */
export function useWorkspaceComposerPlacement(
  overlayElement: HTMLElement | null,
  workspaceKey: string | null,
): WorkspaceComposerPlacement {
  const [slotState, setSlotState] = useState<{
    readonly key: string | null;
    readonly rect: WorkspaceBridgeRect | null;
  }>({ key: null, rect: null });
  const [size, setSize] = useState({ composer: 0, dock: 0 });

  const onComposerSlotChange = useCallback(
    (rect: WorkspaceBridgeRect | null) => {
      const next = roundRect(rect);
      setSlotState((current) =>
        current.key === workspaceKey && rectsEqual(current.rect, next)
          ? current
          : { key: workspaceKey, rect: next },
      );
    },
    [workspaceKey],
  );

  useLayoutEffect(() => {
    if (workspaceKey === null || overlayElement === null) return;
    const stack = overlayElement.querySelector<HTMLElement>("[data-chat-composer-stack]");
    const measure = () => {
      const next = {
        composer: Math.ceil(stack?.getBoundingClientRect().height ?? 0),
        dock: Math.ceil(overlayElement.getBoundingClientRect().height),
      };
      setSize((current) =>
        current.composer === next.composer && current.dock === next.dock ? current : next,
      );
    };
    measure();
    return observeResize(stack ? [overlayElement, stack] : overlayElement, measure);
  }, [overlayElement, workspaceKey]);

  if (workspaceKey === null) {
    return {
      slotted: false,
      overlayClassName: null,
      overlayStyle: undefined,
      composerHeight: 0,
      dockHeight: 0,
      onComposerSlotChange,
    };
  }
  const slot = slotState.key === workspaceKey ? slotState.rect : null;
  return slot === null
    ? {
        slotted: false,
        overlayClassName: "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-2",
        overlayStyle: undefined,
        composerHeight: size.composer,
        dockHeight: size.dock,
        onComposerSlotChange,
      }
    : {
        slotted: true,
        // Bottom-aligned in the slot, so a growing draft extends upward like the docked composer.
        overlayClassName: "pointer-events-none absolute z-20 flex flex-col justify-end",
        overlayStyle: { left: slot.x, top: slot.y, width: slot.width, height: slot.height },
        composerHeight: size.composer,
        dockHeight: 0,
        onComposerSlotChange,
      };
}
