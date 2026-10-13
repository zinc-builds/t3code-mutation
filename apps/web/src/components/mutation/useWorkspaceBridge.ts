import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  readWorkspaceBridgeMessage,
  WORKSPACE_BRIDGE_METHODS,
  workspaceBridgeError,
  workspaceBridgeNotification,
  workspaceBridgeResult,
  type WorkspaceBridgeRect,
  type WorkspaceBridgeRequest,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import { type RefObject, useEffect, useRef } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { mutationWorkspaceEnvironment } from "~/state/mutationWorkspace";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { toastManager } from "../ui/toast";

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
  readonly onSendMessage: (text: string) => Promise<void>;
  readonly onAttachFiles: (files: ReadonlyArray<File>) => void;
  readonly onRestore: () => void;
}

/** A file handed to the page at initialize; Files clone into its opaque origin as they are. */
interface WorkspaceBridgeAsset {
  readonly name: string;
  readonly mimeType: string;
  readonly source: "attachment" | "file";
  readonly file: File;
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : String(error);

const commandError = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => new Error(errorMessage(squashAtomCommandFailure(result)));

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

const agentStatus = (working: boolean) =>
  workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.agentStatus, {
    status: working ? "working" : "idle",
  });
const composerSize = (height: number) =>
  workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.composerSize, { height });

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
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  // Read on every message, so the bridge sees current props without
  // re-subscribing (which would drop requests in flight).
  const live = { options, readState, updateState, createAssetUrl };
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

    const fetchAsset = async (resource: AssetResource, name: string) => {
      const { environmentId } = latest.current.options;
      const connection = readPreparedConnection(environmentId);
      if (connection === null)
        throw new Error("Reconnect to this environment to load the workspace.");
      const minted = await latest.current.createAssetUrl({ environmentId, input: { resource } });
      if (minted._tag !== "Success") throw commandError(minted);
      const url = resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl);
      if (url === null) throw new Error(`The environment returned an invalid URL for ${name}.`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${name} could not be loaded (HTTP ${response.status}).`);
      return response.blob();
    };

    const initialize = async () => {
      const { environmentId, threadId, workspace, threadImages } = latest.current.options;
      const state = latest.current
        .readState({ environmentId, input: { threadId } })
        .then((result) => {
          if (result._tag !== "Success") throw commandError(result);
          return result.value.state;
        });
      const images = threadImages.map(async (image): Promise<WorkspaceBridgeAsset> => {
        const blob = await fetchAsset(
          {
            _tag: "attachment",
            attachmentId: image.attachmentId,
            fileName: image.name,
            mimeType: image.mimeType,
          },
          image.name,
        );
        return {
          name: image.name,
          mimeType: image.mimeType,
          source: "attachment",
          file: new File([blob], image.name, { type: image.mimeType }),
        };
      });
      const files = workspace.assets.map(async (asset): Promise<WorkspaceBridgeAsset> => {
        const blob = await fetchAsset(
          { _tag: "media-file", threadId, path: asset.path },
          asset.name,
        );
        return {
          name: asset.name,
          mimeType: blob.type,
          source: "file",
          file: new File([blob], asset.name, { type: blob.type }),
        };
      });
      const [storedState, assets] = await Promise.all([state, Promise.all([...images, ...files])]);
      // The server answers null before the page stored anything.
      return { state: storedState ?? undefined, assets };
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
          await current.onSendMessage(request.text);
          return {};
        case WORKSPACE_BRIDGE_METHODS.attach:
          current.onAttachFiles(request.files);
          return {};
        case WORKSPACE_BRIDGE_METHODS.download:
          saveBlob(request.file, request.file.name);
          return {};
      }
    };

    const failureTitle = (method: WorkspaceBridgeRequest["method"]) => {
      switch (method) {
        case WORKSPACE_BRIDGE_METHODS.initialize:
          return "Couldn't load the workspace";
        case WORKSPACE_BRIDGE_METHODS.download:
          return "Couldn't save the file";
        // Sending and attaching go through the composer, which reports its own failures.
        case WORKSPACE_BRIDGE_METHODS.send:
        case WORKSPACE_BRIDGE_METHODS.attach:
          return null;
      }
    };

    const respond = (request: WorkspaceBridgeRequest) => {
      void run(request).then(
        (result) => {
          post(workspaceBridgeResult(request.id, result));
          if (request.method === WORKSPACE_BRIDGE_METHODS.initialize) {
            const { composerHeight, agentWorking } = latest.current.options;
            post(composerSize(composerHeight));
            post(agentStatus(agentWorking));
          }
        },
        (error: unknown) => {
          const message = errorMessage(error);
          post(workspaceBridgeError(request.id, message));
          const title = failureTitle(request.method);
          if (title !== null) toastManager.add({ type: "error", title, description: message });
        },
      );
    };

    const saveState = (state: unknown) => {
      const { environmentId, threadId } = latest.current.options;
      void latest.current
        .updateState({ environmentId, input: { threadId, state: state ?? null } })
        .then((result) => {
          if (result._tag === "Success") {
            lastStateFailure = null;
            return;
          }
          const message = errorMessage(squashAtomCommandFailure(result));
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
