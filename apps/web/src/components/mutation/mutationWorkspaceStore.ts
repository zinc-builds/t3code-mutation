import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { readThreadVisibleTurnItems } from "../../state/entities";
import {
  latestWorkspaceEvent,
  type ItemWorkspace,
  type WorkspaceOverride,
} from "./activeWorkspace";

interface MutationWorkspaceStoreState {
  /** Session-only: a reload shows what the agent last left the thread in. */
  readonly overrideByThreadKey: Readonly<Record<string, WorkspaceOverride>>;
  readonly setOverride: (ref: ScopedThreadRef, override: WorkspaceOverride) => void;
}

export const useMutationWorkspaceStore = create<MutationWorkspaceStoreState>((set) => ({
  overrideByThreadKey: {},
  setOverride: (ref, override) =>
    set((state) => ({
      overrideByThreadKey: { ...state.overrideByThreadKey, [scopedThreadKey(ref)]: override },
    })),
}));

/** The newest agent workspace call, read at click time so history rows need no subscription. */
function currentEventId(ref: ScopedThreadRef): string | null {
  return latestWorkspaceEvent(readThreadVisibleTurnItems(ref))?.itemId ?? null;
}

/** Shows `workspace` in the thread until the agent mutates or restores again. */
export function openWorkspace(ref: ScopedThreadRef, workspace: ItemWorkspace) {
  useMutationWorkspaceStore
    .getState()
    .setOverride(ref, { eventId: currentEventId(ref), open: workspace });
}

/** Returns the thread to chat until the agent mutates or restores again. */
export function leaveWorkspace(ref: ScopedThreadRef) {
  useMutationWorkspaceStore
    .getState()
    .setOverride(ref, { eventId: currentEventId(ref), open: null });
}
