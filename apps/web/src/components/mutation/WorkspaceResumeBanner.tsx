import type { ScopedThreadRef } from "@t3tools/contracts";
import { LayoutTemplateIcon } from "lucide-react";
import { memo } from "react";

import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import type { ItemWorkspace } from "@t3tools/client-runtime/state/mutation-workspace-active";
import { openWorkspace } from "./mutationWorkspaceStore";

/** The way back into the agent's workspace after the user returned to chat from it. */
export const WorkspaceResumeBanner = memo(function WorkspaceResumeBanner(props: {
  readonly threadRef: ScopedThreadRef;
  readonly resumable: ItemWorkspace;
}) {
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-workspace-resume-banner="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <LayoutTemplateIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="truncate text-muted-foreground">
              {props.resumable.workspace.title}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => openWorkspace(props.threadRef, props.resumable)}
            >
              Reopen
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
