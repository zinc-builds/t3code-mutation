import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";
import { memo, useState } from "react";

import type { ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Spinner } from "../ui/spinner";

/** The agent's answer to the newest user message, or null while it has not replied yet. */
export function latestWorkspaceReply(messages: ReadonlyArray<ChatMessage>): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") return message.text.trim() === "" ? null : message;
    if (message.role === "user") return null;
  }
  return null;
}

/** One readable line of a Markdown reply. */
function replyPreview(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The conversation while the timeline is replaced: the agent's latest reply,
 * attached above the composer and expandable to the full message.
 */
export const WorkspaceReplyStrip = memo(function WorkspaceReplyStrip(props: {
  readonly reply: ChatMessage | null;
  readonly working: boolean;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}) {
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const { reply } = props;
  if (reply === null && !props.working) return null;
  const expanded = reply !== null && expandedMessageId === reply.id;
  const label = reply === null ? "Working…" : replyPreview(reply.text);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-workspace-reply-strip="true">
        <ComposerBanner.Row
          render={
            <button
              type="button"
              aria-expanded={reply === null ? undefined : expanded}
              disabled={reply === null}
              onClick={() => setExpandedMessageId(expanded || reply === null ? null : reply.id)}
            />
          }
        >
          <ComposerBanner.Icon>
            {props.working ? <Spinner /> : <MessageSquareTextIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span
              className={
                expanded ? "text-muted-foreground" : "line-clamp-2 min-w-0 text-muted-foreground"
              }
            >
              {expanded ? "Latest reply" : label}
            </span>
          </ComposerBanner.Content>
          {reply === null ? null : (
            <ComposerBanner.Actions>
              <ComposerBanner.ToggleIcon expanded={expanded} />
            </ComposerBanner.Actions>
          )}
        </ComposerBanner.Row>
        {expanded ? (
          <ComposerBanner.Scroll>
            <ComposerBanner.Body className="pb-2 text-sm">
              <ChatMarkdown
                text={reply.text}
                cwd={props.cwd}
                threadRef={props.threadRef ?? undefined}
                isStreaming={reply.streaming}
              />
            </ComposerBanner.Body>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
