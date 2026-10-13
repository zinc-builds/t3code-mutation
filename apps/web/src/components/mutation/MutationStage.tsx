import type { WorkspaceInspectorSection } from "@t3tools/shared/mutationWorkspaceChrome";
import type { ComponentProps } from "react";

import { WorkspaceFrame } from "./WorkspaceFrame";
import { WorkspaceInspector } from "./WorkspaceInspector";
import { useWorkspaceChromeStore } from "./workspaceChromeStore";

const ignoreSlot = () => {};

/**
 * The workspace page in place of the timeline. It fills the chat canvas, the
 * same box the composer overlay is positioned in, so the slot rect the page
 * reports is already in overlay coordinates. A docked composer takes
 * `dockHeight` from the bottom instead of floating over the page. When the
 * workspace declares an inspector, it is a native column beside the page and
 * the composer docks at its bottom instead of in a page slot.
 */
export function MutationStage({
  dockHeight,
  ...frameProps
}: ComponentProps<typeof WorkspaceFrame> & { readonly dockHeight: number }) {
  const { attachmentId } = frameProps.workspace;
  const inspector = useWorkspaceChromeStore(
    (state): ReadonlyArray<WorkspaceInspectorSection> | null =>
      state.session?.attachmentId === attachmentId &&
      (state.session.chrome.inspector?.length ?? 0) > 0
        ? (state.session.chrome.inspector ?? null)
        : null,
  );
  return (
    <div
      data-mutation-stage
      className="absolute inset-x-0 top-0 z-10 flex bg-background"
      style={{ bottom: dockHeight }}
    >
      <div className="relative min-w-0 flex-1">
        <WorkspaceFrame
          {...frameProps}
          onComposerSlotChange={inspector === null ? frameProps.onComposerSlotChange : ignoreSlot}
        />
      </div>
      {inspector === null ? null : (
        <WorkspaceInspector
          sections={inspector}
          composerHeight={frameProps.composerHeight}
          onComposerSlotChange={frameProps.onComposerSlotChange}
        />
      )}
    </div>
  );
}
