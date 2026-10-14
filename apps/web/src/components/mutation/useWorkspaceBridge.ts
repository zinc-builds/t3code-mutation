import {
  planWorkspaceAssets,
  startWorkspaceAssetUrlRefresher,
  streamedWorkspaceAssets,
  type PlannedWorkspaceAsset,
} from "@t3tools/client-runtime/state/mutation-workspace-assets";
import {
  workspaceAgentStatusNotification,
  workspaceAssetSources,
  workspaceBridgeFailureTitle,
  workspaceComposerSizeNotification,
  workspaceErrorMessage,
  workspaceInitialPageState,
  workspaceStateErrorNotification,
} from "@t3tools/client-runtime/state/mutation-workspace-host";
import {
  createWorkspacePreviewHost,
  workspacePreviewChangedNotification,
} from "@t3tools/client-runtime/state/mutation-workspace-preview-host";
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
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type RefObject, useContext, useEffect, useRef } from "react";

import { mutationWorkspaceEnvironment } from "~/state/mutationWorkspace";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { fetchWorkspaceAssetBytes, useWorkspaceAssetMinter } from "./useWorkspaceAssets";
import { loadWorkspaceAsset, workspaceAssetKey } from "./workspaceAssetCache";
import { loadWorkspaceBridgeAssets } from "./workspaceBridgeAssets";
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

const commandError = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => new Error(workspaceErrorMessage(squashAtomCommandFailure(result)));

/** A screenshot's bytes as the File the page receives. */
function base64File(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], "preview.png", { type: mimeType });
}

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
  const previewOpen = useAtomCommand(mutationWorkspaceEnvironment.previewOpen, {
    reportFailure: false,
  });
  const previewAct = useAtomCommand(mutationWorkspaceEnvironment.previewAct, {
    reportFailure: false,
  });
  const registry = useContext(RegistryContext);
  const mintAsset = useWorkspaceAssetMinter();
  // Read on every message, so the bridge sees current props without
  // re-subscribing (which would drop requests in flight).
  const live = { options, readState, updateState, mintAsset, previewOpen, previewAct, registry };
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
    let streamedAssets = 0;
    // Attachments never change, so pages share them; a file is fetched per page
    // unless it was prefetched for this one.
    const fetchAsset = (asset: PlannedWorkspaceAsset) => {
      const { environmentId } = latest.current.options;
      const loaded = loadWorkspaceAsset(
        workspaceAssetKey(environmentId, asset.source.resource),
        asset.source.resource._tag === "attachment",
        () => fetchWorkspaceAssetBytes(asset.url, asset.source.name),
      );
      if (loaded.prefetched) prefetchedAssets += 1;
      return loaded.blob;
    };
    // Renews the streamed URLs the page holds; replaced when the page initializes again.
    let urlRefresher: ReturnType<typeof startWorkspaceAssetUrlRefresher> | null = null;
    let lastUrlFailure: string | null = null;

    const initialize = async () => {
      const { environmentId, threadId, workspace, threadImages } = latest.current.options;
      const state = latest.current
        .readState({ environmentId, input: { threadId } })
        .then((result) => {
          if (result._tag !== "Success") throw commandError(result);
          return result.value.state;
        });
      const planned = planWorkspaceAssets(
        workspaceAssetSources(threadId, workspace, threadImages),
        (resource) => latest.current.mintAsset(environmentId, resource),
      );
      const [storedState, plan] = await Promise.all([state, planned]);
      const assets = await loadWorkspaceBridgeAssets(plan, fetchAsset);
      const streamed = streamedWorkspaceAssets(plan);
      initializedAssets = assets.length;
      streamedAssets = streamed.length;
      urlRefresher?.dispose();
      urlRefresher = startWorkspaceAssetUrlRefresher({
        assets: streamed,
        mint: async (resource) =>
          (await latest.current.mintAsset(latest.current.options.environmentId, resource)).url,
        notify: (message) => {
          lastUrlFailure = null;
          post(message);
        },
        // The page keeps its current URLs, which still work for a while; the user
        // hears once per distinct failure that its media may stop.
        onError: (error) => {
          const message = workspaceErrorMessage(error);
          if (message === lastUrlFailure) return;
          lastUrlFailure = message;
          toastManager.add({
            type: "error",
            title: "Couldn't renew the workspace's media links",
            description: `${message} Retrying; playback stops if this keeps failing.`,
          });
        },
      });
      return { state: workspaceInitialPageState(storedState), assets };
    };

    const previewHost = createWorkspacePreviewHost({
      declaredUrl: () => latest.current.options.workspace.preview?.url,
      open: async (input) => {
        const { environmentId, threadId } = latest.current.options;
        const result = await latest.current.previewOpen({
          environmentId,
          input: {
            threadId,
            url: input.url,
            ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
          },
        });
        if (result._tag !== "Success") throw commandError(result);
        return result.value;
      },
      act: async (sessionId, action) => {
        const { environmentId, threadId } = latest.current.options;
        const result = await latest.current.previewAct({
          environmentId,
          input: { threadId, sessionId, action },
        });
        if (result._tag !== "Success") throw commandError(result);
        return result.value;
      },
      close: (sessionId) => {
        const { environmentId, threadId } = latest.current.options;
        // Nothing to report: a page that is already gone needs no closing, and
        // the server closes one nobody follows by itself.
        void latest.current.previewAct({
          environmentId,
          input: { threadId, sessionId, action: { _tag: "close" } },
        });
      },
      follow: (sessionId, onEvent) => {
        const { environmentId, threadId } = latest.current.options;
        return latest.current.registry.subscribe(
          mutationWorkspaceEnvironment.previewEvents({
            environmentId,
            input: { threadId, sessionId },
          }),
          (result) => {
            if (AsyncResult.isSuccess(result)) onEvent(result.value);
          },
          { immediate: true },
        );
      },
      notify: (change) => post(workspacePreviewChangedNotification(change)),
      toFile: base64File,
    });

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
        case WORKSPACE_BRIDGE_METHODS.previewOpen:
          return previewHost.open(request.url, request.viewport);
        case WORKSPACE_BRIDGE_METHODS.preview:
          return previewHost.act(request.action);
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
                  `[workspace] ${workspace.title}: first frame ${Math.round(performance.now() - startedAt)}ms after the page started loading (${initializedAssets} assets: ${streamedAssets} streamed, ${prefetchedAssets} prefetched)`,
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
      previewHost.dispose();
      urlRefresher?.dispose();
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
