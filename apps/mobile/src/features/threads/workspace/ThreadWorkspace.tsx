import type {
  ItemWorkspace,
  ThreadImage,
} from "@t3tools/client-runtime/state/mutation-workspace-active";
import {
  workspaceAgentStatusNotification,
  workspaceAssetSources,
  workspaceBridgeFailureTitle,
  workspaceControlsNotification,
  workspaceErrorMessage,
  workspaceInitialPageState,
  workspaceStateErrorNotification,
  workspaceStateWithPage,
} from "@t3tools/client-runtime/state/mutation-workspace-host";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
} from "@t3tools/shared/htmlRender";
import {
  WORKSPACE_BRIDGE_METHODS,
  workspaceBridgeError,
  workspaceBridgeResult,
  type WorkspaceBridgeRequest,
} from "@t3tools/shared/mutationWorkspace";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../../components/AppText";
import { validateDraftFileAttachments } from "../../../lib/attachmentUpload";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { uuidv4 } from "../../../lib/uuid";
import { assetEnvironment, useAssetUrlState } from "../../../state/assets";
import { mutationWorkspaceEnvironment } from "../../../state/mutationWorkspace";
import { usePreparedConnection } from "../../../state/session";
import { setThreadComposerError } from "../../../state/thread-composer-error";
import { enqueueThreadOutboxMessage } from "../../../state/thread-outbox";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useAtomQueryRunner } from "../../../state/use-atom-query-runner";
import { appendComposerDraftAttachments } from "../../../state/use-composer-drafts";
import { useHtmlRenderTheme } from "../HtmlRenderWebView";
import { shareWorkspaceFile, workspaceDraftAttachments } from "./workspaceFiles";
import {
  readWorkspaceWebViewMessage,
  workspaceInitializeScript,
  workspaceOuterDocument,
  workspaceReceiveScript,
  type WorkspaceEncodedFile,
  type WorkspaceWebViewAsset,
} from "./workspaceWebViewBridge";

export interface ThreadWorkspaceProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspace: ItemWorkspace;
  readonly threadImages: ReadonlyArray<ThreadImage>;
  readonly agentWorking: boolean;
  /** The draft the composer shows, which files the page attaches join. */
  readonly composerDraftKey: string | null;
  readonly serverConfig: ServerConfig | null;
  /** The page asked for the chat interface back. */
  readonly onRestore: () => void;
}

const originOf = (url: string) => /^https?:\/\/[^/?#]+/i.exec(url)?.[0] ?? null;

const commandError = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => new Error(workspaceErrorMessage(squashAtomCommandFailure(result)));

/**
 * A thread's mutation workspace on a phone: the agent's page filling the
 * thread's view in a WebView that speaks the workspace bridge. The native
 * composer stays docked below it (the page's composer slot is not used), and
 * the thread screen gives the way back to chat. A new workspace (a new
 * attachment) is a new page.
 */
export function ThreadWorkspace(props: ThreadWorkspaceProps) {
  // Reloading after the page left its document, or its web process died, loads the page again.
  const [generation, setGeneration] = useState(0);
  return (
    <WorkspaceDocument
      key={`${props.workspace.workspace.attachmentId}:${generation}`}
      {...props}
      onReload={() => setGeneration((value) => value + 1)}
    />
  );
}

function WorkspaceDocument(props: ThreadWorkspaceProps & { readonly onReload: () => void }) {
  const { attachmentId, title } = props.workspace.workspace;
  const theme = useHtmlRenderTheme();
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName: htmlRenderFileName(title),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, title],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  // The page keeps its first URL: a re-minted one would reload it and drop the
  // user's unsaved work. It reads the theme from the fragment before first paint.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") {
    setUri(`${asset.url.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  }
  const [secret] = useState(uuidv4);
  const [loaded, setLoaded] = useState(false);
  const [stopped, setStopped] = useState<"navigated" | "crashed" | null>(null);
  const webView = useRef<WebView<object>>(null);

  const connection = usePreparedConnection(props.environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const readState = useAtomCommand(mutationWorkspaceEnvironment.readState, {
    reportFailure: false,
  });
  const updateState = useAtomCommand(mutationWorkspaceEnvironment.updateState, {
    reportFailure: false,
  });
  // Read on every message, so the bridge sees current props without being rebuilt.
  const live = { props, theme, httpBaseUrl, createAssetUrl, readState, updateState };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });
  // The thread's stored state as last read or written, so a page without the
  // chrome's controls keeps their values when it stores its own state.
  const stored = useRef<unknown>(null);
  const initialized = useRef(false);
  const lastStateFailure = useRef<string | null>(null);

  const post = (message: unknown) =>
    webView.current?.injectJavaScript(workspaceReceiveScript(message));

  // The page sees the theme and the agent's status change once it is running.
  useEffect(() => {
    if (loaded) post(htmlRenderThemeMessage(theme));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Resent when the theme changes.
  }, [theme, loaded]);
  useEffect(() => {
    if (initialized.current) post(workspaceAgentStatusNotification(props.agentWorking));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Resent when the status changes.
  }, [props.agentWorking]);

  const mintAssetUrls = async (): Promise<WorkspaceWebViewAsset[]> => {
    const { props: current, createAssetUrl: mint, httpBaseUrl: baseUrl } = latest.current;
    const sources = workspaceAssetSources(
      current.threadId,
      current.workspace.workspace,
      current.threadImages,
    );
    return Promise.all(
      sources.map(async (source): Promise<WorkspaceWebViewAsset> => {
        const minted = await mint({
          environmentId: current.environmentId,
          input: { resource: source.resource },
        });
        if (minted._tag !== "Success") throw commandError(minted);
        const state = assetUrlStateFromResult(minted, baseUrl);
        if (state._tag !== "Success") {
          throw new Error(`Reconnect to this environment to load ${source.name}.`);
        }
        const common = { name: source.name, mimeType: source.mimeType, url: state.url };
        return source.source === "attachment"
          ? { ...common, source: "attachment", attachmentId: source.attachmentId }
          : { ...common, source: "file", path: source.path };
      }),
    );
  };

  const initialize = async (id: string | number) => {
    const { props: current } = latest.current;
    const [read, assets] = await Promise.all([
      latest.current.readState({
        environmentId: current.environmentId,
        input: { threadId: current.threadId },
      }),
      mintAssetUrls(),
    ]);
    if (read._tag !== "Success") throw commandError(read);
    stored.current = read.value.state;
    // The outer page fetches the files and answers the page itself.
    webView.current?.injectJavaScript(
      workspaceInitializeScript(id, workspaceInitialPageState(read.value.state), assets),
    );
    initialized.current = true;
    post(workspaceAgentStatusNotification(current.agentWorking));
    const controls = workspaceControlsNotification(current.workspace.workspace, read.value.state);
    if (controls !== null) post(controls);
  };

  const composerAttachments = async (files: ReadonlyArray<WorkspaceEncodedFile>) => {
    const attachments = await workspaceDraftAttachments(files);
    const blocked = validateDraftFileAttachments({
      attachments,
      serverConfig: latest.current.props.serverConfig,
    });
    if (blocked !== null) throw new Error(blocked);
    return attachments;
  };

  const run = async (request: WorkspaceBridgeRequest<WorkspaceEncodedFile>, active: boolean) => {
    const { props: current } = latest.current;
    switch (request.method) {
      case WORKSPACE_BRIDGE_METHODS.initialize:
        await initialize(request.id);
        return undefined;
      case WORKSPACE_BRIDGE_METHODS.send: {
        // A page cannot spend the user's turns on its own: a message goes out
        // only right after the user touched the workspace.
        if (!active) throw new Error("Messages send only from a tap in the workspace.");
        if (request.files.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          throw new Error(`A message carries at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files.`);
        }
        // Through the outbox like a typed message, so it survives a dropped
        // connection; the thread's own settings fill in when it sends.
        await enqueueThreadOutboxMessage({
          environmentId: current.environmentId,
          threadId: current.threadId,
          messageId: MessageId.make(uuidv4()),
          commandId: CommandId.make(uuidv4()),
          text: request.text,
          attachments: await composerAttachments(request.files),
          dispatchMode: "queue",
          createdAt: new Date().toISOString(),
        });
        return {};
      }
      case WORKSPACE_BRIDGE_METHODS.attach: {
        if (current.composerDraftKey === null) throw new Error("The composer is not available.");
        const rejected = appendComposerDraftAttachments(
          current.composerDraftKey,
          await composerAttachments(request.files),
          { appendReference: true },
        );
        if (rejected > 0) {
          throw new Error(
            `The composer holds at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
          );
        }
        return {};
      }
      case WORKSPACE_BRIDGE_METHODS.download:
        await shareWorkspaceFile(request.file);
        return {};
    }
  };

  const respond = (request: WorkspaceBridgeRequest<WorkspaceEncodedFile>, active: boolean) => {
    void run(request, active).then(
      // Initialize is answered by the outer page once it has the files.
      (result) => result !== undefined && post(workspaceBridgeResult(request.id, result)),
      (error: unknown) => {
        const message = workspaceErrorMessage(error);
        post(workspaceBridgeError(request.id, message));
        const { props: current } = latest.current;
        const title = workspaceBridgeFailureTitle(request.method);
        if (title !== null) {
          Alert.alert(title, message);
        } else {
          // Sending and attaching are the composer's work, so it shows why they failed.
          setThreadComposerError(scopedThreadKey(current.environmentId, current.threadId), message);
        }
      },
    );
  };

  const saveState = (state: unknown) => {
    const { props: current } = latest.current;
    const next = workspaceStateWithPage(current.workspace.workspace, stored.current, state);
    stored.current = next;
    void latest.current
      .updateState({
        environmentId: current.environmentId,
        input: { threadId: current.threadId, state: next },
      })
      .then((result) => {
        if (result._tag === "Success") {
          lastStateFailure.current = null;
          return;
        }
        const message = workspaceErrorMessage(squashAtomCommandFailure(result));
        // The page hears about every failure; the user once per distinct one.
        post(workspaceStateErrorNotification(message));
        if (message === lastStateFailure.current) return;
        lastStateFailure.current = message;
        Alert.alert("Couldn't save the workspace controls", message);
      });
  };

  const receive = (event: WebViewMessageEvent) => {
    const message = readWorkspaceWebViewMessage(event.nativeEvent.data, secret);
    if (message === undefined) return;
    switch (message.kind) {
      case "navigated":
        setStopped("navigated");
        return;
      case "assets-failed":
        Alert.alert("Couldn't load the workspace", message.message);
        return;
      case "set-chrome":
        post(
          workspaceBridgeError(
            message.id,
            "Workspace toolbars and inspectors are not on mobile yet.",
          ),
        );
        return;
      case "open-link":
        if (!message.active) {
          post(workspaceBridgeError(message.id, "Links open only from a tap in the workspace."));
          return;
        }
        void tryOpenExternalUrl(message.url, "html-render").then((opened) =>
          post(
            opened
              ? htmlRenderResult(message.id)
              : workspaceBridgeError(message.id, "The link could not be opened."),
          ),
        );
        return;
      case "bridge": {
        const bridge = message.message;
        if ("id" in bridge) {
          respond(bridge, message.active);
          return;
        }
        switch (bridge.method) {
          case WORKSPACE_BRIDGE_METHODS.setState:
            saveState(bridge.state);
            return;
          case WORKSPACE_BRIDGE_METHODS.restore:
            latest.current.props.onRestore();
            return;
          case WORKSPACE_BRIDGE_METHODS.composerSlot:
            // The composer docks below the page on mobile.
            return;
        }
      }
    }
  };

  const origin = uri === null ? null : originOf(uri);
  const source = useMemo(
    () =>
      uri === null || origin === null
        ? null
        : // The environment's origin, so the outer page fetches assets same-origin.
          { html: workspaceOuterDocument(uri, secret), baseUrl: `${origin}/` },
    [uri, origin, secret],
  );

  if (stopped !== null) {
    return (
      <View className="flex-1 items-center justify-center gap-2 px-6">
        <Text className="text-center text-sm text-foreground-muted">
          {stopped === "navigated"
            ? `${title} left its page and was stopped`
            : `${title} stopped responding`}
        </Text>
        <Pressable accessibilityRole="button" onPress={props.onReload} hitSlop={8}>
          <Text className="text-sm font-t3-medium text-foreground">Reload workspace</Text>
        </Pressable>
      </View>
    );
  }
  if (source === null) {
    return (
      <View className="flex-1 items-center justify-center">
        {asset._tag === "Failure" || (uri !== null && origin === null) ? (
          <Text className="text-sm text-foreground-muted">Unable to load {title}</Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }
  return (
    <View className="flex-1">
      <WebView<object>
        ref={webView}
        source={source}
        accessibilityLabel={title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        originWhitelist={["*"]}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        overScrollMode="never"
        // Only the outer page loads at the top; the page opens links through
        // the bridge. Android reports every navigation as top-frame, frames
        // included, so it has no gate to apply; the page frame's sandbox
        // forbids top navigation and popups either way.
        onShouldStartLoadWithRequest={(request) =>
          Platform.OS === "android" ||
          request.isTopFrame === false ||
          request.url === "about:blank" ||
          request.url === `${origin}/`
        }
        setSupportMultipleWindows={false}
        onLoadEnd={() => setLoaded(true)}
        onError={() => setStopped("crashed")}
        onContentProcessDidTerminate={() => setStopped("crashed")}
        onRenderProcessGone={() => setStopped("crashed")}
        onMessage={receive}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}
