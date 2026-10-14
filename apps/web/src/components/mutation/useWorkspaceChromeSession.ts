import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { WorkspaceReference } from "@t3tools/shared/mutationWorkspace";
import { workspaceStateEnvelope } from "@t3tools/shared/mutationWorkspaceChrome";
import { useEffect, useLayoutEffect, useRef } from "react";

import { mutationWorkspaceEnvironment } from "~/state/mutationWorkspace";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import {
  closeWorkspaceChromeSession,
  loadWorkspaceChromeState,
  openWorkspaceChromeSession,
  useWorkspaceChromeStore,
  type WorkspaceChromeSession,
} from "./workspaceChromeStore";

/** Values settle this long before they are stored, so a slider drag is one write. */
const SAVE_DELAY_MS = 300;

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Runs the chrome session of the shown workspace, when the agent declared
 * chrome: opens it in a layout effect (so the sidebar and header reshape in
 * the same morph as the page), reads the thread's stored values, and stores
 * `{ controls, page }` as values and the page's state change.
 */
export function useWorkspaceChromeSession(
  threadRef: ScopedThreadRef | null,
  workspace: WorkspaceReference | null,
) {
  const attachmentId = workspace?.chrome === undefined ? null : workspace.attachmentId;
  const chrome = workspace?.chrome;
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const readState = useAtomCommand(mutationWorkspaceEnvironment.readState, {
    reportFailure: false,
  });
  const updateState = useAtomCommand(mutationWorkspaceEnvironment.updateState, {
    reportFailure: false,
  });
  const latest = useRef({ chrome, readState, updateState });
  useLayoutEffect(() => {
    latest.current = { chrome, readState, updateState };
  });

  // Keyed by attachment alone: a manifest is fixed per attachment, and
  // reopening would drop the values.
  useLayoutEffect(() => {
    const declared = latest.current.chrome;
    if (attachmentId === null || declared === undefined) return;
    openWorkspaceChromeSession(attachmentId, declared);
    return () => closeWorkspaceChromeSession(attachmentId);
  }, [attachmentId]);

  useEffect(() => {
    if (attachmentId === null || environmentId === null || threadId === null) return;
    let cancelled = false;
    void latest.current.readState({ environmentId, input: { threadId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        loadWorkspaceChromeState(attachmentId, { state: result.value.state });
        return;
      }
      loadWorkspaceChromeState(attachmentId, undefined);
      toastManager.add({
        type: "error",
        title: "Couldn't load the workspace controls",
        description: failureMessage(result),
      });
    });

    // Saves the newest stored-worthy snapshot. It is kept here, not read back
    // from the store, because the session is already closed when this
    // effect's cleanup flushes the last change.
    let pending: WorkspaceChromeSession | null = null;
    let savedRevision = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFailure: string | null = null;
    const save = () => {
      timer = null;
      const session = pending;
      pending = null;
      if (session === null) return;
      void latest.current
        .updateState({
          environmentId,
          input: { threadId, state: workspaceStateEnvelope(session.values, session.pageState) },
        })
        .then((result) => {
          if (result._tag === "Success") {
            lastFailure = null;
            return;
          }
          const message = failureMessage(result);
          if (message === lastFailure) return;
          lastFailure = message;
          toastManager.add({
            type: "error",
            title: "Couldn't save the workspace controls",
            description: message,
          });
        });
    };
    const unsubscribe = useWorkspaceChromeStore.subscribe(({ session }) => {
      if (session === null || session.attachmentId !== attachmentId || !session.loaded) return;
      if (session.revision === savedRevision) return;
      savedRevision = session.revision;
      pending = session;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
        save();
      }
    };
  }, [attachmentId, environmentId, threadId]);
}
