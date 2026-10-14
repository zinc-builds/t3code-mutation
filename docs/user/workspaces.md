# Workspaces

For hands-on work you adjust by eye over several steps, an agent can turn the thread into a workspace: an editor built for the task, shown in place of the chat. Photo grading, cropping for social, cutting video, trimming audio, exploring a CSV, laying out a poster, building a slide deck, and staging a 3D scene each have a ready-made editor, and an agent can add its own tools to one or build something new when none fits. It works with every provider, on web, desktop, and mobile.

## Starting a Workspace

Attach the file or name its path, and ask for an editor: "open this photo in an editor", "let me cut these clips", "give me a workspace to explore trips.csv". A one-shot request such as "make it black and white" gets a direct edit instead; ask for a workspace if you want to fine-tune by hand. To get more tools, ask the agent while the workspace is open ("add a vignette slider"); it rebuilds the workspace in place and keeps your settings.

## Working Alongside the Agent

The composer stays available while a workspace is open. Each message you send carries the workspace's current settings, so "make the shadows a bit warmer" or "apply this to the full-resolution file" refers to what you have set, not what you started with.

**Export** adds the result to the composer, ready to send, and saves a copy to your machine. Video and audio editors export an edit list and an ffmpeg command rather than a rendered file: send them to the agent and ask it to render, which needs ffmpeg on the machine running T3 Code.

## Editing by What Is Said

To cut footage by its content ("make a 2–3 minute edit of the most insightful things said in this folder"), point the agent at the files or their folder. It first transcribes them on the machine running T3 Code, with a timestamp for every word, then reads the transcripts and builds the editor from them. Your media is used where it lives and is never copied; the only new files are the transcripts, kept in T3 Code's own cache, so asking again later is instant.

Transcription is English only. The first time, T3 Code installs its speech engine (Phonon-2 by Fermion Research) into its home directory and downloads the model (about 160 MB), which takes a minute or two and needs Python 3.12 or newer and ffmpeg on that machine. If either is missing, the agent tells you what to install; set `T3CODE_PYTHON` to use a particular Python. Long batches keep transcribing in the background, and the agent collects the results when they finish.

## Reviewing a Web Page

Ask for a review workspace on a page, usually your dev server: "open localhost:5173 so I can mark up the design". The workspace shows the live page, refreshes when it changes (a hot reload), and lets you pin notes to elements, so the agent gets exact selectors and styles instead of a screenshot to interpret. T3 Code loads the page in its own headless browser on the machine running it, signed out, and only opens addresses the agent named or that the thread's preview shows. Not available on mobile yet.

## Leaving and Reopening

Use **Back to chat** (on mobile, **Chat** or Android back) to return to the conversation; the workspace and your settings are kept. Reopen it from the banner above the composer or from its row in the thread. Ask the agent when you are done and it closes the workspace for the thread.

## Things to Know

- A workspace only sends a message for you right after you click or press a key in it. Nothing is posted in the background.
- Like [visual replies](html-renders.md), a workspace is sandboxed away from T3 Code and your session, and follows your theme.
- On mobile, toolbars and side panels that T3 Code draws natively on desktop and web are not shown yet; editors that use them fall back to their own controls. Files a workspace sends or saves on mobile are limited to 25 MB each.
- Before the agent hands a workspace over, T3 Code loads it in its own headless browser and, when the agent added tools, runs its export to catch mistakes. The first check on a machine downloads that browser once, as with visual replies.
