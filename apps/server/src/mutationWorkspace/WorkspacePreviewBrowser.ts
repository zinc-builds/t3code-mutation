// @effect-diagnostics preferSchemaOverJson:off - in-page scripts and their JSON arguments run in the reviewed page.
/**
 * The pages a workspace's live preview runs in, and the Playwright
 * implementation on the server's shared headless browser. The page reads it
 * needs (elements under a point, computed styles, a highlight) run as scripts
 * in the reviewed page, so this module is the only one that knows them.
 */
import {
  WorkspacePreviewError,
  type WorkspacePreviewElement,
  type WorkspacePreviewViewport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Page } from "playwright-core";

import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";

/** What made a review page change without the workspace asking. */
export type WorkspacePreviewPageEvent = "loaded" | "navigated" | "mutated" | "closed";

export interface WorkspacePreviewCapture {
  readonly png: Uint8Array;
  /** CSS pixels the image covers. */
  readonly width: number;
  readonly height: number;
  readonly scrollY: number;
}

/** One live page, owned by the scope it was opened in. */
export interface WorkspacePreviewPage {
  /** Loads a URL and waits for its load event. */
  readonly goto: (url: string) => Effect.Effect<void, WorkspacePreviewError>;
  readonly reload: Effect.Effect<void, WorkspacePreviewError>;
  readonly location: Effect.Effect<{ readonly url: string; readonly title: string }>;
  readonly viewport: Effect.Effect<WorkspacePreviewViewport>;
  readonly setViewport: (
    viewport: WorkspacePreviewViewport,
  ) => Effect.Effect<void, WorkspacePreviewError>;
  /** The viewport, or the document from its top down to `maxHeight` CSS pixels. */
  readonly screenshot: (options: {
    readonly fullPage: boolean;
    readonly maxHeight: number;
  }) => Effect.Effect<WorkspacePreviewCapture, WorkspacePreviewError>;
  /** Elements under a document point, innermost first. */
  readonly elementsAt: (
    x: number,
    y: number,
  ) => Effect.Effect<ReadonlyArray<WorkspacePreviewElement>, WorkspacePreviewError>;
  readonly inspect: (
    selector: string,
  ) => Effect.Effect<WorkspacePreviewElement | null, WorkspacePreviewError>;
  /** Outlines the element, or clears the outline for null. False when nothing matches. */
  readonly highlight: (selector: string | null) => Effect.Effect<boolean, WorkspacePreviewError>;
  /** Replaces T3's stylesheet in the page; it is applied again after every load. */
  readonly setStyles: (css: string) => Effect.Effect<void, WorkspacePreviewError>;
  /** Scrolls the document and returns where it landed. */
  readonly scrollTo: (y: number) => Effect.Effect<number, WorkspacePreviewError>;
}

export class WorkspacePreviewBrowser extends Context.Service<
  WorkspacePreviewBrowser,
  {
    /**
     * A blank page with its own throwaway storage, closed with the scope.
     * `onEvent` hears the page change on its own, outside the Effect runtime.
     */
    readonly open: (input: {
      readonly viewport: WorkspacePreviewViewport;
      readonly onEvent: (event: WorkspacePreviewPageEvent) => void;
    }) => Effect.Effect<WorkspacePreviewPage, WorkspacePreviewError, Scope.Scope>;
  }
>()("t3/mutationWorkspace/WorkspacePreviewBrowser") {}

const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
/** Marks T3's own nodes in the reviewed page, which reads and change events skip. */
const MARK = "data-t3-review";
const CHANGED_BINDING = "__t3ReviewChanged";
const STYLES_BINDING = "__t3ReviewStyles";
/** T3's stylesheet in the page, apart from its highlight outline. */
const STYLES_MARK = "styles";

const isHostError = Schema.is(
  Schema.Union([
    PreviewBrowser.PreviewBrowserInstallError,
    PreviewBrowser.PreviewBrowserInstallingError,
    PreviewBrowser.PreviewBrowserUnsupportedError,
    PreviewBrowserHost.PreviewBrowserSandboxError,
    PreviewBrowserHost.PreviewBrowserLibrariesError,
  ]),
);

/**
 * Reports document changes the page makes itself (a dev server's hot reload,
 * content arriving) at most about once a second, skipping inline style
 * changes, which animations make every frame, and T3's own highlight.
 */
const CHANGE_OBSERVER_SCRIPT = `(() => {
  const mark = ${JSON.stringify(MARK)};
  let timer = 0, first = 0;
  const own = (node) => {
    const element = node && node.nodeType === 1 ? node : node && node.parentElement;
    return Boolean(element && element.closest && element.closest("[" + mark + "]"));
  };
  const ownNodes = (record) => {
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && node.hasAttribute(mark));
  };
  const relevant = (record) =>
    !(record.type === "attributes" && record.attributeName === "style") && !own(record.target) && !ownNodes(record);
  new MutationObserver((records) => {
    if (!records.some(relevant)) return;
    const now = Date.now();
    if (!first) first = now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      first = 0;
      window[${JSON.stringify(CHANGED_BINDING)}]();
    }, now - first > 1000 ? 0 : 300);
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})()`;

/** Applies T3's stylesheet again once each new document has parsed. */
const STYLES_RESTORE_SCRIPT = `document.addEventListener("DOMContentLoaded", () => {
  window[${JSON.stringify(STYLES_BINDING)}]().then((css) => {
    if (!css) return;
    const style = document.createElement("style");
    style.setAttribute(${JSON.stringify(MARK)}, ${JSON.stringify(STYLES_MARK)});
    style.textContent = css;
    document.documentElement.appendChild(style);
  });
})`;

/**
 * Reads and marks elements. Coordinates are document CSS pixels. A point
 * outside the viewport is scrolled into it for the read and scrolled back.
 */
const REVIEW_SCRIPT = `(call) => {
  const mark = ${JSON.stringify(MARK)};
  const styleKeys = ["display", "position", "box-sizing", "width", "height", "margin", "padding", "gap",
    "flex-direction", "justify-content", "align-items", "grid-template-columns", "color", "background-color",
    "background-image", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
    "text-transform", "border", "border-radius", "box-shadow", "opacity", "z-index", "overflow"];
  const escape = (value) => CSS.escape(value);
  const unique = (selector) => document.querySelectorAll(selector).length === 1;
  const selectorFor = (element) => {
    if (element.id && unique("#" + escape(element.id))) return "#" + escape(element.id);
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      const testId = node.getAttribute("data-testid");
      if (testId !== null && unique("[data-testid=" + JSON.stringify(testId) + "]")) {
        parts.unshift("[data-testid=" + JSON.stringify(testId) + "]");
        return parts.join(" > ");
      }
      if (node !== element && node.id && unique("#" + escape(node.id))) {
        parts.unshift("#" + escape(node.id));
        return parts.join(" > ");
      }
      // Class names keep the selector readable for the agent and stable when siblings move.
      let part = node.localName + Array.from(node.classList).slice(0, 3).map((name) => "." + escape(name)).join("");
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (same.filter((child) => child.matches(part)).length > 1) {
          part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) return parts.join(" > ");
    }
    return ["html", ...parts].join(" > ");
  };
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const styles = {};
    for (const key of styleKeys) styles[key] = computed.getPropertyValue(key);
    return {
      selector: selectorFor(element),
      tag: element.localName,
      box: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height },
      text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300),
      html: element.outerHTML.slice(0, 1000),
      styles,
    };
  };
  const query = (selector) => {
    try {
      return { element: document.querySelector(selector) };
    } catch (error) {
      return { invalid: String(error && error.message || error) };
    }
  };
  const scrollTo = (top) => window.scrollTo({ top, behavior: "instant" });
  switch (call.op) {
    case "elementsAt": {
      const restore = scrollY;
      const outside = call.y < scrollY || call.y >= scrollY + innerHeight;
      if (outside) scrollTo(Math.max(0, call.y - innerHeight / 2));
      const found = document
        .elementsFromPoint(call.x - scrollX, call.y - scrollY)
        .filter((element) => element !== document.documentElement && !element.closest("[" + mark + "]"))
        .slice(0, 8)
        .map(describe);
      if (outside) scrollTo(restore);
      return found;
    }
    case "inspect": {
      const result = query(call.selector);
      return "invalid" in result ? result : { element: result.element ? describe(result.element) : null };
    }
    case "highlight": {
      for (const node of document.querySelectorAll("[" + mark + "]:not(style)")) node.remove();
      if (call.selector === null) return { matched: true };
      const result = query(call.selector);
      if ("invalid" in result) return result;
      if (!result.element) return { matched: false };
      const rect = result.element.getBoundingClientRect();
      const outline = document.createElement("div");
      outline.setAttribute(mark, "");
      Object.assign(outline.style, {
        position: "absolute", left: rect.left + scrollX + "px", top: rect.top + scrollY + "px",
        width: rect.width + "px", height: rect.height + "px", boxSizing: "border-box",
        outline: "2px solid #ff2d75", outlineOffset: "1px", background: "rgba(255, 45, 117, 0.08)",
        pointerEvents: "none", zIndex: "2147483647",
      });
      document.documentElement.appendChild(outline);
      return { matched: true };
    }
    case "styles": {
      let style = document.querySelector("style[" + mark + "]");
      if (!call.css) {
        if (style) style.remove();
        return null;
      }
      if (!style) {
        style = document.createElement("style");
        style.setAttribute(mark, ${JSON.stringify(STYLES_MARK)});
        document.documentElement.appendChild(style);
      }
      style.textContent = call.css;
      return null;
    }
    case "scroll":
      scrollTo(call.y);
      return scrollY;
    case "metrics":
      return {
        scrollY,
        height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      };
  }
}`;

const failed = (cause: unknown) =>
  new WorkspacePreviewError({ reason: "failed", detail: undefined, cause });

/** Runs one REVIEW_SCRIPT call in the page. */
const review = <A>(page: Page, call: Record<string, unknown>) =>
  Effect.tryPromise({
    try: () => page.evaluate(`(${REVIEW_SCRIPT})(${JSON.stringify(call)})`) as Promise<A>,
    catch: failed,
  }).pipe(
    Effect.timeoutOrElse({
      duration: ACTION_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new WorkspacePreviewError({
            reason: "failed",
            detail: "The page did not answer in time.",
          }),
        ),
    }),
  );

/** Why a load failed, in the browser's own words but never the page's. */
const loadFailure = (cause: unknown) => {
  const text = cause instanceof Error ? cause.message : String(cause);
  const code = /net::(ERR_[A-Z_]+)/.exec(text)?.[1];
  if (code !== undefined) return `(${code})`;
  return /timeout/i.test(text)
    ? `It did not finish loading in ${NAVIGATION_TIMEOUT_MS / 1000} seconds.`
    : undefined;
};

const invalidSelector = (detail: string) =>
  new WorkspacePreviewError({ reason: "invalid-selector", detail });

/**
 * A blank Playwright page as a review page: sized, reporting its own changes
 * to `onEvent` from its next navigation on.
 */
export const makePlaywrightPreviewPage = Effect.fn("WorkspacePreviewBrowser.makePlaywrightPage")(
  function* (
    page: Page,
    viewport: WorkspacePreviewViewport,
    onEvent: (event: WorkspacePreviewPageEvent) => void,
  ) {
    const styles = { css: "" };
    yield* Effect.tryPromise({
      try: async () => {
        await page.setViewportSize(viewport);
        await page.exposeBinding(CHANGED_BINDING, () => onEvent("mutated"));
        await page.exposeBinding(STYLES_BINDING, () => styles.css);
        await page.addInitScript(CHANGE_OBSERVER_SCRIPT);
        await page.addInitScript(STYLES_RESTORE_SCRIPT);
      },
      catch: failed,
    });
    page.on("load", () => onEvent("loaded"));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) onEvent("navigated");
    });
    page.on("crash", () => onEvent("closed"));
    page.on("close", () => onEvent("closed"));
    return reviewPage(page, styles);
  },
);

const reviewPage = (page: Page, styles: { css: string }): WorkspacePreviewPage => {
  const navigate = (run: () => Promise<unknown>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new WorkspacePreviewError({ reason: "unreachable", detail: loadFailure(cause), cause }),
    }).pipe(Effect.asVoid);
  const viewport = Effect.sync(() => page.viewportSize() ?? { width: 1280, height: 720 });

  return {
    goto: (url) =>
      navigate(() => page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS })),
    reload: navigate(() => page.reload({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS })),
    location: Effect.promise(async () => ({
      url: page.url(),
      title: (await page.title().catch(() => "")).slice(0, 512),
    })),
    viewport,
    setViewport: (size) =>
      Effect.tryPromise({ try: () => page.setViewportSize(size), catch: failed }),
    screenshot: ({ fullPage, maxHeight }) =>
      Effect.gen(function* () {
        const size = yield* viewport;
        const metrics = yield* review<{ readonly scrollY: number; readonly height: number }>(page, {
          op: "metrics",
        });
        const height = fullPage ? Math.min(Math.max(metrics.height, 1), maxHeight) : size.height;
        const png = yield* Effect.tryPromise({
          // A full page is captured at one image pixel per CSS pixel to bound its size.
          try: () =>
            fullPage
              ? page.screenshot({
                  fullPage: true,
                  clip: { x: 0, y: 0, width: size.width, height },
                  scale: "css",
                  timeout: ACTION_TIMEOUT_MS,
                })
              : page.screenshot({ timeout: ACTION_TIMEOUT_MS }),
          catch: failed,
        });
        return {
          png: new Uint8Array(png),
          width: size.width,
          height,
          scrollY: fullPage ? 0 : metrics.scrollY,
        };
      }),
    elementsAt: (x, y) =>
      review<ReadonlyArray<WorkspacePreviewElement>>(page, { op: "elementsAt", x, y }),
    inspect: (selector) =>
      review<{ readonly element: WorkspacePreviewElement | null } | { readonly invalid: string }>(
        page,
        { op: "inspect", selector },
      ).pipe(
        Effect.flatMap((result) =>
          "invalid" in result
            ? Effect.fail(invalidSelector(result.invalid))
            : Effect.succeed(result.element),
        ),
      ),
    highlight: (selector) =>
      review<{ readonly matched: boolean } | { readonly invalid: string }>(page, {
        op: "highlight",
        selector,
      }).pipe(
        Effect.flatMap((result) =>
          "invalid" in result
            ? Effect.fail(invalidSelector(result.invalid))
            : Effect.succeed(result.matched),
        ),
      ),
    setStyles: (css) =>
      review<null>(page, { op: "styles", css }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            styles.css = css;
          }),
        ),
        Effect.asVoid,
      ),
    scrollTo: (y) => review<number>(page, { op: "scroll", y }),
  };
};

/** Review pages in the server's shared headless browser, apart from every preview tab. */
export const layerServerBrowser = Layer.effect(
  WorkspacePreviewBrowser,
  Effect.gen(function* () {
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const open: WorkspacePreviewBrowser["Service"]["open"] = ({ viewport, onEvent }) =>
      Effect.gen(function* () {
        const page = yield* serverBrowser.scratchPage.pipe(
          Effect.mapError((error) => {
            const cause = error.cause;
            return new WorkspacePreviewError({
              reason: "unavailable",
              detail: isHostError(cause) ? cause.message : undefined,
              cause: error,
            });
          }),
        );
        return yield* makePlaywrightPreviewPage(page, viewport, onEvent);
      });
    return WorkspacePreviewBrowser.of({ open });
  }),
);
