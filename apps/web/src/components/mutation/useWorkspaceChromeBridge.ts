import {
  WORKSPACE_BRIDGE_METHODS,
  workspaceBridgeError,
  workspaceBridgeNotification,
  workspaceBridgeResult,
} from "@t3tools/shared/mutationWorkspace";
import {
  readWorkspaceChromeBridgeMessage,
  WORKSPACE_CHROME_BRIDGE_METHODS,
  workspaceChromeShortcutCommand,
  type WorkspaceKeyInput,
} from "@t3tools/shared/mutationWorkspaceChrome";
import { type RefObject, useEffect } from "react";

import { isEditableFocused } from "~/lib/editableFocus";
import { isMacPlatform } from "~/lib/utils";

import {
  patchWorkspaceChrome,
  performWorkspaceChromeCommand,
  subscribeWorkspaceChromeEvents,
  useWorkspaceChromeStore,
} from "./workspaceChromeStore";

const EMPTY_VALUES = Object.freeze({});

/** Runs the toolbar shortcut `event` triggers, if any; true when one ran. */
function runShortcut(attachmentId: string, event: WorkspaceKeyInput): boolean {
  const { session } = useWorkspaceChromeStore.getState();
  if (session === null || session.attachmentId !== attachmentId) return false;
  const command = workspaceChromeShortcutCommand(
    session.chrome,
    session.values,
    event,
    isMacPlatform(navigator.platform),
  );
  if (command === undefined) return false;
  performWorkspaceChromeCommand(command);
  return true;
}

/**
 * The chrome half of the workspace bridge for the page in `frameRef`: sends
 * it control values (when it initializes and on every user change) and user
 * commands, applies its `setChrome` patches, and runs toolbar shortcuts from
 * keys it forwards or that reach T3 itself. A workspace without chrome gets
 * empty controls and a clear error from `setChrome`.
 */
export function useWorkspaceChromeBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  attachmentId: string,
) {
  useEffect(() => {
    if (!enabled) return;
    const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, "*");
    const postControls = (values: object) =>
      post(workspaceBridgeNotification(WORKSPACE_CHROME_BRIDGE_METHODS.controls, { values }));

    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source === null || event.source !== frame.contentWindow) return;
      const data = event.data as { readonly method?: unknown } | null;
      if (data?.method === WORKSPACE_BRIDGE_METHODS.initialize) {
        // A session still reading stored values sends them once loaded instead.
        const { session } = useWorkspaceChromeStore.getState();
        if (session === null || session.attachmentId !== attachmentId) postControls(EMPTY_VALUES);
        else if (session.loaded) postControls(session.values);
        return;
      }
      const message = readWorkspaceChromeBridgeMessage(event.data);
      if (message === undefined) return;
      if ("id" in message) {
        const error = patchWorkspaceChrome(attachmentId, message.patch);
        post(
          error === undefined
            ? workspaceBridgeResult(message.id, {})
            : workspaceBridgeError(message.id, error),
        );
        return;
      }
      runShortcut(attachmentId, message.event);
    };

    // Keys that reach T3 itself: outside text fields, and only those nothing else handled.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isEditableFocused(event.target)) return;
      if (runShortcut(attachmentId, event)) event.preventDefault();
    };

    const unsubscribe = subscribeWorkspaceChromeEvents((chromeEvent) => {
      if (chromeEvent.attachmentId !== attachmentId) return;
      if (chromeEvent.kind === "controls") postControls(chromeEvent.values);
      else
        post(
          workspaceBridgeNotification(WORKSPACE_CHROME_BRIDGE_METHODS.command, chromeEvent.command),
        );
    });
    window.addEventListener("message", receive);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unsubscribe();
      window.removeEventListener("message", receive);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [attachmentId, enabled, frameRef]);
}
