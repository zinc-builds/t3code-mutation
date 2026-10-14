import { WORKSPACE_VENDOR_ROUTE, type WorkspaceKit, workspaceKit } from "@t3tools/workspace-kit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

// Any origin may read these files without credentials. Workspace pages run in
// opaque-origin frames, so their module imports and fetches arrive with
// `Origin: null`, and `*` is the value such a request accepts.
const SHARED_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Whether an If-None-Match header names this strong ETag (weak comparison, as for GET). */
const matches = (ifNoneMatch: string, etag: string) =>
  ifNoneMatch.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//i, "") === etag;
  });

/**
 * The response for a path under WORKSPACE_VENDOR_ROUTE: the vendored file it
 * names, or 404 for any library, version, hash or file the kit does not ship.
 */
export function vendorFileResponse(
  kit: WorkspaceKit,
  path: string,
  ifNoneMatch: string | undefined,
): HttpServerResponse.HttpServerResponse {
  const file = kit.vendorFile(path);
  if (file === undefined) {
    // Not cached: the next release may ship this library at this path.
    return HttpServerResponse.text("Not Found", {
      status: 404,
      headers: { ...SHARED_HEADERS, "Cache-Control": "no-store" },
    });
  }
  const headers = { ...SHARED_HEADERS, "Cache-Control": IMMUTABLE, ETag: file.etag };
  if (ifNoneMatch !== undefined && matches(ifNoneMatch, file.etag)) {
    return HttpServerResponse.empty({ status: 304, headers });
  }
  return HttpServerResponse.uint8Array(file.body, { contentType: file.contentType, headers });
}

/**
 * Serves the files of the kit's vendored libraries (`t3kit.vendor`) to
 * workspace pages, and to anything else that asks. It needs no auth: every
 * file is a pinned open-source release or the kit's own init script, the same
 * bytes in every T3 build, and nothing in a path or response depends on the
 * environment or its user. A page could not present credentials anyway: its
 * opaque origin sends no cookies, and a signed URL baked into a stored page
 * would expire.
 */
export const layerWithKit = (kit: WorkspaceKit) =>
  HttpRouter.add(
    "GET",
    `${WORKSPACE_VENDOR_ROUTE}*`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
      return vendorFileResponse(
        kit,
        url.value.pathname.slice(WORKSPACE_VENDOR_ROUTE.length),
        request.headers["if-none-match"],
      );
    }),
  );

export const layer = layerWithKit(workspaceKit);
