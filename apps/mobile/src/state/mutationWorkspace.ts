import { useAtomValue } from "@effect/atom-react";
import { createMutationWorkspaceEnvironmentAtoms } from "@t3tools/client-runtime/state/mutation-workspace";
import {
  itemWorkspacesEqual,
  latestWorkspaceEvent,
  resolveActiveWorkspace,
  threadImagesEqual,
  threadImagesFromTurnItems,
  workspaceOverride,
  type ItemWorkspace,
  type ThreadImage,
  type WorkspaceOverride,
} from "@t3tools/client-runtime/state/mutation-workspace-active";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreadDetails } from "./threads";
import { useThreadVisibleTurnItems } from "./use-thread-detail";

/** The thread's stored workspace control state, read and replaced for the page. */
export const mutationWorkspaceEnvironment =
  createMutationWorkspaceEnvironmentAtoms(connectionAtomRuntime);

/**
 * What the user chose per thread (back to chat, or reopening a workspace from
 * the timeline), keyed by `scopedThreadKey`. Session-only: a relaunch shows
 * what the agent last left the thread in.
 */
const workspaceOverridesAtom = Atom.make<Readonly<Record<string, WorkspaceOverride>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:mutation-workspace-overrides"),
);

function setWorkspaceOverride(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  open: ItemWorkspace | null,
) {
  // Read at tap time, so timeline rows need no subscription to the thread's items.
  const items = appAtomRegistry.get(
    environmentThreadDetails.visibleTurnItemsAtom({ environmentId, threadId }),
  );
  appAtomRegistry.set(workspaceOverridesAtom, {
    ...appAtomRegistry.get(workspaceOverridesAtom),
    [scopedThreadKey(environmentId, threadId)]: workspaceOverride(items, open),
  });
}

/** Shows `workspace` in the thread until the agent mutates or restores again. */
export function openThreadWorkspace(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  workspace: ItemWorkspace,
) {
  setWorkspaceOverride(environmentId, threadId, workspace);
}

/** Returns the thread to chat until the agent mutates or restores again. */
export function leaveThreadWorkspace(environmentId: EnvironmentId, threadId: ThreadId) {
  setWorkspaceOverride(environmentId, threadId, null);
}

const EMPTY_IMAGES: ReadonlyArray<ThreadImage> = Object.freeze([]);

/** Keeps the previous value while `equal` says nothing changed, so the WebView keeps its props. */
function useEqualValue<T>(value: T, equal: (left: T, right: T) => boolean): T {
  const [kept, setKept] = useState(value);
  const same = equal(kept, value);
  if (!same) setKept(value);
  return same ? kept : value;
}

/** The workspace the thread shows now, and the images the page can work on. */
export function useThreadWorkspace(environmentId: EnvironmentId, threadId: ThreadId) {
  const items = useThreadVisibleTurnItems({ environmentId, threadId });
  const latest = useMemo(() => latestWorkspaceEvent(items), [items]);
  const override = useAtomValue(workspaceOverridesAtom)[scopedThreadKey(environmentId, threadId)];
  const active = useEqualValue(resolveActiveWorkspace(latest, override), itemWorkspacesEqual);
  const images = useMemo(
    () => (active === null ? EMPTY_IMAGES : threadImagesFromTurnItems(items)),
    [active, items],
  );
  return { active, threadImages: useEqualValue(images, threadImagesEqual) };
}
