import { MessageSquareIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

/**
 * The thread header while a workspace is shown: the thread sits one level up
 * in the breadcrumb, so returning to chat reads as going back, not closing.
 */
export function MutationTitleBar(props: {
  readonly threadTitle: string;
  readonly workspaceTitle: string;
  readonly onBackToChat: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <WorkspaceBreadcrumb ariaLabel="Workspace breadcrumb" className="flex-1">
        <WorkspaceBreadcrumbItem className="shrink">
          <button
            type="button"
            onClick={props.onBackToChat}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <WorkspaceBreadcrumbText className="max-w-60">
              {props.threadTitle}
            </WorkspaceBreadcrumbText>
          </button>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          <h2 className="min-w-0">
            <WorkspaceBreadcrumbText>{props.workspaceTitle}</WorkspaceBreadcrumbText>
          </h2>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <Button size="xs" variant="ghost-muted" onClick={props.onBackToChat}>
        <MessageSquareIcon />
        Back to chat
      </Button>
    </div>
  );
}
