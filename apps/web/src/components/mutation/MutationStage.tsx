import type { ComponentProps } from "react";

import { WorkspaceFrame } from "./WorkspaceFrame";

/**
 * The workspace page in place of the timeline. It fills the chat canvas, the
 * same box the composer overlay is positioned in, so the slot rect the page
 * reports is already in overlay coordinates. A docked composer takes
 * `dockHeight` from the bottom instead of floating over the page.
 */
export function MutationStage({
  dockHeight,
  ...frameProps
}: ComponentProps<typeof WorkspaceFrame> & { readonly dockHeight: number }) {
  return (
    <div
      data-mutation-stage
      className="absolute inset-x-0 top-0 z-10 bg-background"
      style={{ bottom: dockHeight }}
    >
      <WorkspaceFrame {...frameProps} />
    </div>
  );
}
