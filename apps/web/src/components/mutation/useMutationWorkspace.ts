import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useSidebar } from "../ui/sidebar";
import {
  itemWorkspacesEqual,
  latestWorkspaceEvent,
  resolveActiveWorkspace,
  resumableWorkspace,
  threadImagesEqual,
  threadImagesFromTurnItems,
  type ItemWorkspace,
  type ThreadImage,
} from "./activeWorkspace";
import { useMutationWorkspaceStore } from "./mutationWorkspaceStore";

const EMPTY_IMAGES: ReadonlyArray<ThreadImage> = Object.freeze([]);

/** Keeps the previous value while `equal` says nothing changed, so frames keep their props. */
function useEqualValue<T>(value: T, equal: (left: T, right: T) => boolean): T {
  const [kept, setKept] = useState(value);
  const same = equal(kept, value);
  if (!same) setKept(value);
  return same ? kept : value;
}

/**
 * The workspace the thread should show now, the agent's workspace the user
 * left (to offer it back), and the images the page can work on.
 */
export function useActiveWorkspace(
  threadRef: ScopedThreadRef | null,
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
) {
  const latest = useMemo(() => latestWorkspaceEvent(visibleTurnItems), [visibleTurnItems]);
  const override = useMutationWorkspaceStore((state) =>
    threadRef === null ? undefined : state.overrideByThreadKey[scopedThreadKey(threadRef)],
  );
  const active = useEqualValue(
    threadRef === null ? null : resolveActiveWorkspace(latest, override),
    itemWorkspacesEqual,
  );
  const resumable = useEqualValue(resumableWorkspace(latest, active), itemWorkspacesEqual);
  const images = useMemo(
    () => (active === null ? EMPTY_IMAGES : threadImagesFromTurnItems(visibleTurnItems)),
    [active, visibleTurnItems],
  );
  return { active, resumable, threadImages: useEqualValue(images, threadImagesEqual) };
}

type MorphDocument = Document & {
  startViewTransition?: (update: () => void) => { readonly finished: Promise<void> };
};

let morphToken = 0;

/**
 * Runs a layout change as one view transition: the composer flies to its new
 * place while the rest crossfades (index.css, `data-mutation-morph`). Instant
 * without the API, with reduced motion, or with panel animations off.
 */
function runMorph(update: () => void, animate: boolean) {
  const morphDocument = document as MorphDocument;
  if (
    !animate ||
    !morphDocument.startViewTransition ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  const token = ++morphToken;
  const root = morphDocument.documentElement;
  root.dataset.mutationMorph = "true";
  const transition = morphDocument.startViewTransition(() => flushSync(update));
  const settle = () => {
    if (token === morphToken) delete root.dataset.mutationMorph;
  };
  void transition.finished.then(settle, settle);
}

/**
 * What the thread view shows. A change within one thread morphs the layout;
 * switching threads shows the other thread's state at once.
 */
function useShownWorkspace(
  threadKey: string | null,
  active: ItemWorkspace | null,
  animate: boolean,
): ItemWorkspace | null {
  const [shown, setShown] = useState({ threadKey, workspace: active });
  const latestRef = useRef({ threadKey, workspace: active });
  useLayoutEffect(() => {
    latestRef.current = { threadKey, workspace: active };
  });
  if (shown.threadKey !== threadKey) setShown({ threadKey, workspace: active });
  useEffect(() => {
    if (shown.threadKey !== threadKey || itemWorkspacesEqual(shown.workspace, active)) return;
    // The transition calls back after a frame; show whatever is newest by then.
    runMorph(() => setShown(latestRef.current), animate);
  }, [active, animate, shown, threadKey]);
  return shown.threadKey === threadKey ? shown.workspace : active;
}

/** Collapses the app sidebar while mutated and reopens it afterwards if it was open. */
function useCollapsedSidebar(collapsed: boolean) {
  const { isMobile, open, setOpen } = useSidebar();
  const sidebarRef = useRef({ open, setOpen });
  useLayoutEffect(() => {
    sidebarRef.current = { open, setOpen };
  });
  useLayoutEffect(() => {
    if (!collapsed || isMobile || !sidebarRef.current.open) return;
    void sidebarRef.current.setOpen(false);
    return () => void sidebarRef.current.setOpen(true);
  }, [collapsed, isMobile]);
}

/**
 * The thread's mutation state for ChatView: which workspace is shown (after
 * its morph), which one can be resumed, and the thread images the page can read.
 */
export function useMutationWorkspace(
  threadRef: ScopedThreadRef | null,
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  animate: boolean,
) {
  const { active, resumable, threadImages } = useActiveWorkspace(threadRef, visibleTurnItems);
  const shown = useShownWorkspace(
    threadRef === null ? null : scopedThreadKey(threadRef),
    active,
    animate,
  );
  useCollapsedSidebar(shown !== null);
  return { shown, resumable, threadImages };
}
