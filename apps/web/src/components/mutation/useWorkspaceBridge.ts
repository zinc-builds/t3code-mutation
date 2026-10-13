import {
  workspaceAgentStatusNotification,
  workspaceAssetSources,
  workspaceBridgeFailureTitle,
  workspaceComposerSizeNotification,
  workspaceErrorMessage,
  workspaceInitialPageState,
  workspaceStateErrorNotification,
  type WorkspaceAssetSource,
} from "@t3tools/client-runtime/state/mutation-workspace-host";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  readWorkspaceBridgeMessage,
  WORKSPACE_BRIDGE_METHODS,
  workspaceBridgeError,
  workspaceBridgeResult,
  type WorkspaceBridgeRect,
  type WorkspaceBridgeRequest,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import { type RefObject, useEffect, useRef } from "react";

import { mutationWorkspaceEnvironment } from "~/state/mutationWorkspace";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { useWorkspaceAssetFetcher } from "./useWorkspaceAssets";
import { loadWorkspaceAsset, workspaceAssetKey } from "./workspaceAssetCache";
import { setWorkspaceChromePageState } from "./workspaceChromeStore";

export interface WorkspaceBridgeOptions {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspace: WorkspaceReference;
  readonly threadImages: ReadonlyArray<{
    readonly attachmentId: string;
    readonly name: string;
    readonly mimeType: string;
  }>;
  readonly agentWorking: boolean;
  readonly composerHeight: number;
  readonly onComposerSlotChange: (rect: WorkspaceBridgeRect | null) => void;
  /** Sends a message as the user, with the files the page sent along in the same message. */
  readonly onSendMessage: (text: string, files: ReadonlyArray<File>) => Promise<void>;
  readonly onAttachFiles: (files: ReadonlyArray<File>) => void;
  readonly onRestore: () => void;
}

/**
 * A file handed to the page at initialize; Files clone into its opaque origin
 * as they are. Each carries what the agent knows it by, so the page can name it
 * in what it sends back.
 */
type WorkspaceBridgeAsset = {
  readonly name: string;
  readonly mimeType: string;
  readonly file: File;
} & (
  | { readonly source: "attachment"; readonly attachmentId: string }
  | { readonly source: "file"; readonly path: string }
);

const commandError = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => new Error(workspaceErrorMessage(squashAtomCommandFailure(result)));

/** Saves a file through the browser's own download, which asks where when it is set to. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Long after the browser has read it: some start the download a task or
  // more after the click, and a revoked URL saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const agentStatus = workspaceAgentStatusNotification;
const composerSize = workspaceComposerSizeNotification;

/**
 * Hosts the `t3/workspace/*` bridge for the page in `frameRef` while `enabled`:
 * answers its requests from the thread (stored state, media, chat), and tells it
 * the composer's height and whether the agent is working. Only messages from
 * that frame's own window are read. A failed request is returned to the page as
 * a JSON-RPC error; failures of the host's own work (loading, saving state,
 * downloads) are also shown to the user.
 */
export function useWorkspaceBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  options: WorkspaceBridgeOptions,
) {
  const readState = useAtomCommand(mutationWorkspaceEnvironment.readState, {
    reportFailure: false,
  });
  const updateState = useAtomCommand(mutationWorkspaceEnvironment.updateState, {
    reportFailure: false,
  });
  const fetchAsset = useWorkspaceAssetFetcher();
  // Read on every message, so the bridge sees current props without
  // re-subscribing (which would drop requests in flight).
  const live = { options, readState, updateState, fetchAsset };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  useEffect(() => {
    if (!enabled) return;
    // The page's origin is opaque, so "*" is the only target that reaches it;
    // the window reference itself scopes delivery to this frame.
    const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, "*");
    // One toast per distinct failure, so a page saving as a slider moves
    // does not stack the same error.
    let lastStateFailure: string | null = null;

    // Since the page started loading, for the dev time-to-first-frame log.
    const startedAt = performance.now();
    let prefetchedAssets = 0;
    let initializedAssets = 0;
    // Attachments never change, so pages share them; a file is fetched per page
    // unless it was prefetched for this one.
    const fetchAsset = (source: WorkspaceAssetSource) => {
      const { environmentId } = latest.current.options;
      const loaded = loadWorkspaceAsset(
        workspaceAssetKey(environmentId, source.resource),
        source.resource._tag === "attachment",
        () => latest.current.fetchAsset(environmentId, source.resource, source.name),
      );
      if (loaded.prefetched) prefetchedAssets += 1;
      return loaded.blob;
    };

    const initialize = async () => {
      const { environmentId, threadId, workspace, threadImages } = latest.current.options;
      const state = latest.current
        .readState({ environmentId, input: { threadId } })
        .then((result) => {
          if (result._tag !== "Success") throw commandError(result);
          return result.value.state;
        });
      const files = workspaceAssetSources(threadId, workspace, threadImages).map(
        async (source): Promise<WorkspaceBridgeAsset> => {
          const blob = await fetchAsset(source);
          const mimeType = source.mimeType ?? blob.type;
          const file = new File([blob], source.name, { type: mimeType });
          return source.source === "attachment"
            ? {
                name: source.name,
                mimeType,
                source: "attachment",
                attachmentId: source.attachmentId,
                file,
              }
            : { name: source.name, mimeType, source: "file", path: source.path, file };
        },
      );
      const [storedState, assets] = await Promise.all([state, Promise.all(files)]);
      initializedAssets = assets.length;
      return { state: workspaceInitialPageState(storedState), assets };
    };

    const run = async (request: WorkspaceBridgeRequest) => {
      const { options: current } = latest.current;
      switch (request.method) {
        case WORKSPACE_BRIDGE_METHODS.initialize:
          return initialize();
        case WORKSPACE_BRIDGE_METHODS.send:
          // A page cannot spend the user's turns on its own: a message goes
          // out only right after the user clicked or typed in the workspace.
          if (navigator.userActivation?.isActive === false) {
            throw new Error("Messages send only from a click or key press in the workspace.");
          }
          await current.onSendMessage(request.text, request.files);
          return {};
        case WORKSPACE_BRIDGE_METHODS.attach:
          current.onAttachFiles(request.files);
          return {};
        case WORKSPACE_BRIDGE_METHODS.download:
          saveBlob(request.file, request.file.name);
          return {};
      }
    };

    const respond = (request: WorkspaceBridgeRequest) => {
      void run(request).then(
        (result) => {
          post(workspaceBridgeResult(request.id, result));
          if (request.method === WORKSPACE_BRIDGE_METHODS.initialize) {
            const { composerHeight, agentWorking, workspace } = latest.current.options;
            post(composerSize(composerHeight));
            post(agentStatus(agentWorking));
            if (import.meta.env.DEV) {
              // The page draws its media in the frame after it has them.
              requestAnimationFrame(() => {
                console.debug(
                  `[workspace] ${workspace.title}: first frame ${Math.round(performance.now() - startedAt)}ms after the page started loading (${prefetchedAssets}/${initializedAssets} assets prefetched)`,
                );
              });
            }
          }
        },
        (error: unknown) => {
          const message = workspaceErrorMessage(error);
          post(workspaceBridgeError(request.id, message));
          const title = workspaceBridgeFailureTitle(request.method);
          if (title !== null) toastManager.add({ type: "error", title, description: message });
        },
      );
    };

    const saveState = (state: unknown) => {
      const { environmentId, threadId, workspace } = latest.current.options;
      // The chrome session stores it beside the control values.
      if (setWorkspaceChromePageState(workspace.attachmentId, state)) return;
      void latest.current
        .updateState({ environmentId, input: { threadId, state: state ?? null } })
        .then((result) => {
          if (result._tag === "Success") {
            lastStateFailure = null;
            return;
          }
          const message = workspaceErrorMessage(squashAtomCommandFailure(result));
          // The page hears about every failure; the user once per distinct one.
          post(workspaceStateErrorNotification(message));
          if (message === lastStateFailure) return;
          lastStateFailure = message;
          toastManager.add({
            type: "error",
            title: "Couldn't save the workspace controls",
            description: message,
          });
        });
    };

    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source === null || event.source !== frame.contentWindow) return;
      const message = readWorkspaceBridgeMessage(event.data);
      if (message === undefined) return;
      if ("id" in message) {
        respond(message);
        return;
      }
      const { options: current } = latest.current;
      switch (message.method) {
        case WORKSPACE_BRIDGE_METHODS.setState:
          saveState(message.state);
          return;
        case WORKSPACE_BRIDGE_METHODS.restore:
          current.onRestore();
          return;
        case WORKSPACE_BRIDGE_METHODS.composerSlot:
          current.onComposerSlotChange(message.rect);
          return;
      }
    };

    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      // The page is gone or no longer trusted, so its slot no longer holds the composer.
      latest.current.options.onComposerSlotChange(null);
    };
  }, [enabled, frameRef]);

  const { composerHeight, agentWorking } = options;
  useEffect(() => {
    if (enabled) frameRef.current?.contentWindow?.postMessage(composerSize(composerHeight), "*");
  }, [enabled, frameRef, composerHeight]);
  useEffect(() => {
    if (enabled) frameRef.current?.contentWindow?.postMessage(agentStatus(agentWorking), "*");
  }, [enabled, frameRef, agentWorking]);
}
