# Mutation Workspaces

A workspace is an agent-published HTML page that replaces a thread's chat view. The agent reaches it through the `workspace_*` MCP tools; [MutationWorkspace](../../apps/server/src/mutationWorkspace/MutationWorkspace.ts) is the service behind them. These are the constraints that cross the server, the kit, and the clients.

## One Bridge, Every Host

The page runs in an opaque-origin `sandbox="allow-scripts allow-forms"` frame and talks to its host only through the JSON-RPC bridge in [mutationWorkspace.ts](../../packages/shared/src/mutationWorkspace.ts), which T3 injects ahead of the page's own scripts. Web hosts the frame directly. Mobile hosts the same sandboxed frame inside a WebView, so the bridge and every page run unchanged; the outer WebView page is loaded from the environment's origin so the frame can fetch signed asset URLs without CORS failures. Do not give mobile a separate bridge dialect: a page that works on web must work there.

Hosts own the decisions a page cannot be trusted with. `send` is honoured only during user activation (iOS before 16.4 reports no activation and is allowed through). Mobile does not render native chrome yet and rejects `setChrome`, so every page must keep a working in-page fallback for its toolbar.

## The Kit Is Baked In

The server is bundled and cannot read kit files at runtime, so primitives and templates live in the generated [`packages/workspace-kit/src/generated.ts`](../../packages/workspace-kit/src/generated.ts). Edit the kit sources in [`packages/workspace-kit/kit`](../../packages/workspace-kit/kit) (primitives, templates and their contracts) and rerun `node packages/workspace-kit/scripts/generate.mjs`, never the generated file. The generator rejects malformed templates and every example's options, and `template.json` is kept verbatim so bolt-on docs reach agents through `workspace_kit_docs`. The catalog in the `workspace_mutate` description rides in every session's tool list, so its per-entry size is tested.

A template's `"chrome": true` means its page projects its toolbar into T3's native chrome at runtime. The client only accepts `setChrome` for a workspace published with a manifest, so the kit plan seeds an empty one (`{}`) when the agent passes none.

## Validation Mirrors the Client

Before returning, `workspace_mutate` boots the page in T3's own headless browser with a stand-in for the client side of the bridge ([workspaceValidation.ts](../../apps/server/src/mutationWorkspace/workspaceValidation.ts)). At `full` it also runs `t3template.export()` and dry-runs any ffmpeg commands it returns with the host's ffmpeg. The stand-in must answer the way the clients do: when a client starts rejecting a bridge request, or accepts a new shape, change the stand-in too, or agents get a clean validation for a page that breaks for users.

Assets follow the same rule. Hosts load the files a workspace was handed as `workspace-asset` resources, which the server serves whatever their type but only for a path a `workspace_mutate` call in the thread (or its fork source) declared ([WorkspaceAssets.ts](../../apps/server/src/mutationWorkspace/WorkspaceAssets.ts)). Publishing opens and types each asset through the same [WorkspaceAssetFile.ts](../../apps/server/src/assets/WorkspaceAssetFile.ts) the route uses, so do not hand workspaces files through `media-file`, whose preview-only type policy validation would not see.

## Live Previews Run in Their Own Page

A workspace that reviews a web page (`t3.workspace.preview`) cannot load or read the site from its sandbox, and a remote client often cannot reach the host's `localhost` at all, so [WorkspacePreview.ts](../../apps/server/src/mutationWorkspace/WorkspacePreview.ts) opens it in a scratch page of the server's shared headless browser and the page works on screenshots and element reads. It deliberately does not drive the thread's preview tab: that tab may be a desktop `<webview>` the server cannot read, an agent or the user may hold its [SessionControl](../../apps/server/src/preview/SessionControl.ts), and resizing or outlining it would change what the user sees in the preview panel. A scratch page has throwaway storage, so a review starts signed out. It opens only on an origin a `workspace_mutate` call declared as `preview` (found like declared assets) or one the thread's preview tabs show, which keeps a page from using the host as a proxy into its network. It lives while a client follows `workspace.subscribePreview` and closes a minute after the last follower leaves, so a reconnecting client keeps its page and a closed tab leaks nothing. Mobile does not carry screenshots across its WebView yet and rejects preview requests.
