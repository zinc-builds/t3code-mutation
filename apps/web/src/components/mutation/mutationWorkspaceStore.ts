import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { readThreadVisibleTurnItems } from "../../state/entities";
import {
  workspaceOverride,
  type ItemWorkspace,
  type WorkspaceOverride,
} from "@t3tools/client-runtime/state/mutation-workspace-active";

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

// The thread's items are read at click time, so history rows need no subscription.

/** Shows `workspace` in the thread until the agent mutates or restores again. */
export function openWorkspace(ref: ScopedThreadRef, workspace: ItemWorkspace) {
  useMutationWorkspaceStore
    .getState()
    .setOverride(ref, workspaceOverride(readThreadVisibleTurnItems(ref), workspace));
}

/** Returns the thread to chat until the agent mutates or restores again. */
export function leaveWorkspace(ref: ScopedThreadRef) {
  useMutationWorkspaceStore
    .getState()
    .setOverride(ref, workspaceOverride(readThreadVisibleTurnItems(ref), null));
}
