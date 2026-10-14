import type { ScopedThreadRef } from "@t3tools/contracts";
import type { WorkspaceReference } from "@t3tools/shared/mutationWorkspace";
import { LayoutTemplateIcon } from "lucide-react";

import { Button } from "../ui/button";
import { openWorkspace } from "./mutationWorkspaceStore";

/** Where the agent rebuilt the interface; reopens that workspace after the thread went back to chat. */
export function WorkspaceHistoryRow(props: {
  readonly itemId: string;
  readonly workspace: WorkspaceReference;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { threadRef } = props;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-0.5 text-sm">
      <LayoutTemplateIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        Workspace <span className="font-medium text-foreground">{props.workspace.title}</span>
      </span>
      {threadRef === null ? null : (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            openWorkspace(threadRef, { itemId: props.itemId, workspace: props.workspace })
          }
        >
          Open
        </Button>
      )}
    </div>
  );
}
