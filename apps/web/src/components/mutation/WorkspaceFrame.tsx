import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import type { WorkspaceBridgeRect, WorkspaceReference } from "@t3tools/shared/mutationWorkspace";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

import { Button } from "../ui/button";
import { useWorkspaceBridge } from "./useWorkspaceBridge";

/** A cached asset URL with less life than this is minted afresh first. */
const MIN_URL_LIFE_MS = 5 * 60_000;

export interface WorkspaceFrameProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspace: WorkspaceReference;
  /** Images the user attached in this thread, newest last. */
  readonly threadImages: ReadonlyArray<{
    readonly attachmentId: string;
    readonly name: string;
    readonly mimeType: string;
  }>;
  readonly agentWorking: boolean;
  /** Composer height in CSS px, sent to the page so its slot fits it. */
  readonly composerHeight: number;
  /** Where the page's data-t3-composer slot sits, relative to the frame's top-left; null when the page has none. */
  readonly onComposerSlotChange: (rect: WorkspaceBridgeRect | null) => void;
  readonly onSendMessage: (text: string, files: ReadonlyArray<File>) => Promise<void>;
  readonly onAttachFiles: (files: ReadonlyArray<File>) => void;
  readonly onRestore: () => void;
}

/**
 * A thread's mutation workspace: the agent's page filling the box it is given,
 * edge to edge with no chrome, in an opaque-origin frame that speaks the
 * workspace bridge. Fill the thread's view with it and lay the composer over the
 * slot it reports. A new workspace (a new attachment) is a new page.
 */
export function WorkspaceFrame(props: WorkspaceFrameProps): JSX.Element {
  // Reloading after the page left its document loads the stored page again.
  const [generation, setGeneration] = useState(0);
  return (
    <WorkspaceDocument
      key={`${props.workspace.attachmentId}:${generation}`}
      {...props}
      onReload={() => setGeneration((value) => value + 1)}
    />
  );
}

function WorkspaceDocument(props: WorkspaceFrameProps & { readonly onReload: () => void }) {
  const { attachmentId, title } = props.workspace;
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
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

  // The frame keeps its first URL: a re-minted one would reload the page and
  // drop the user's unsaved work. A cached URL near expiry is minted afresh
  // first, since a frame cannot report a failed load; at most once, so a
  // skewed clock cannot mint on every update.
  const [src, setSrc] = useState<string | null>(null);
  const [mintFailed, setMintFailed] = useState(false);
  const minting = useRef(false);
  const asset = useAssetUrlState(src === null ? props.environmentId : null, resource);
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const cachedUrl = asset._tag === "Success" ? asset.url : null;
  const cachedExpiresAt = asset._tag === "Success" ? asset.expiresAt : 0;
  useEffect(() => {
    if (src !== null || cachedUrl === null || minting.current) return;
    // The page reads the theme from its fragment before first paint.
    const withTheme = (url: string) => `${url.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      // oxlint-disable-next-line react/set-state-in-effect -- Adopts the cached URL once it is known to last.
      setSrc(withTheme(cachedUrl));
      return;
    }
    minting.current = true;
    void refresh().then(
      (url) => (url === null ? setMintFailed(true) : setSrc(withTheme(url))),
      () => setMintFailed(true),
    );
  }, [src, cachedUrl, cachedExpiresAt, refresh, theme]);

  // The bridge belongs to the stored document. A frame that navigates keeps
  // its window, so a second load stops the bridge rather than letting a page
  // T3 never served send messages as the user.
  const loads = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);

  useWorkspaceBridge(frameRef, src !== null && !navigatedAway, props);

  // Links in the page open in the browser, only right after the user clicked
  // in the workspace, as with HTML renders.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);

  if (navigatedAway) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
        <p>{title} left its page and was stopped</p>
        <Button size="sm" variant="outline" onClick={props.onReload}>
          Reload workspace
        </Button>
      </div>
    );
  }
  if (src === null) {
    return asset._tag === "Failure" || mintFailed ? (
      <p className="flex size-full items-center justify-center text-muted-foreground text-sm">
        Unable to load {title}
      </p>
    ) : (
      <div className="size-full" />
    );
  }
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      // Never allow-same-origin: the opaque origin keeps the page out of the
      // app's session. Downloads go through the bridge.
      sandbox="allow-scripts allow-forms"
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) {
          setNavigatedAway(true);
          return;
        }
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      className="block size-full border-0 scheme-light"
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
