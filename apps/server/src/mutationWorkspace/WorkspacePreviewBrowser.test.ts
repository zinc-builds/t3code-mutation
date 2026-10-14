import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";

import * as WorkspacePreviewBrowser from "./WorkspacePreviewBrowser.ts";

// Real-browser test; runs only when this names a chrome-headless-shell (or Chrome).
const executable = process.env.T3CODE_TEST_HEADLESS_SHELL;

const PAGE = `<!doctype html><body style="margin:0">
<section id="hero" style="height:300px"><h1 style="margin:0;font-size:40px">Ship faster</h1></section>
<ul><li>One</li><li>Two</li></ul>
<div style="height:2000px"></div>
<footer data-testid="footer" style="height:100px">Bye</footer>
<div class="actions"><a class="btn primary">Start</a><a class="btn">Tour</a></div>
<div class="plan"><a class="btn primary">Buy</a></div>
</body>`;

it.effect.skipIf(executable === undefined)(
  "reads, outlines, and captures a live page, and hears it change",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch({ executablePath: executable!, headless: true })),
          (browser) => Effect.promise(() => browser.close()),
        );
        const page = yield* Effect.promise(() => browser.newPage());
        const mutated = yield* Deferred.make<void>();
        const review = yield* WorkspacePreviewBrowser.makePlaywrightPreviewPage(
          page,
          { width: 800, height: 600 },
          (event) => {
            if (event === "mutated") Deferred.doneUnsafe(mutated, Effect.void);
          },
        );
        yield* review.goto(`data:text/html,${encodeURIComponent(PAGE)}`);

        // The shortest selector unique in the page.
        const [heading] = yield* review.elementsAt(10, 10);
        assert.strictEqual(heading!.selector, "h1");
        assert.strictEqual(heading!.text, "Ship faster");
        assert.strictEqual(heading!.styles["font-size"], "40px");

        // A point below the viewport is read in document coordinates, and the page stays put.
        const [footer] = yield* review.elementsAt(10, 2400);
        assert.strictEqual(footer!.selector, '[data-testid="footer"]');
        assert.isAbove(footer!.box.y, 2300);
        const shot = yield* review.screenshot({ fullPage: false, maxHeight: 8_000 });
        assert.strictEqual(shot.scrollY, 0);
        assert.deepStrictEqual(Array.from(shot.png.slice(1, 4)), [80, 78, 71]);

        // Class names first; a position only among siblings the classes do not tell apart.
        const start = yield* review.inspect(".actions .primary");
        assert.strictEqual(start?.selector, "div.actions > a.btn.primary");
        const tour = yield* review.inspect(".actions a:last-child");
        assert.strictEqual(tour?.selector, "a.btn:nth-of-type(2)");

        const second = yield* review.inspect("li:nth-of-type(2)");
        assert.strictEqual(second?.text, "Two");
        assert.isNull(yield* review.inspect(".missing"));
        const invalid = yield* review.inspect("[[").pipe(Effect.flip);
        assert.strictEqual(invalid.reason, "invalid-selector");

        assert.isTrue(yield* review.highlight("#hero"));
        assert.isFalse(yield* review.highlight(".missing"));
        // The outline is T3's own, so reads look through it.
        const [underOutline] = yield* review.elementsAt(10, 10);
        assert.strictEqual(underOutline!.selector, "h1");

        // T3's stylesheet previews CSS, outlives the highlight and reloads, and goes with "".
        const fontSize = Effect.map(review.inspect("h1"), (h1) => h1?.styles["font-size"]);
        yield* review.setStyles("h1 { font-size: 12px !important; }");
        assert.strictEqual(yield* fontSize, "12px");
        assert.isTrue(yield* review.highlight(null));
        assert.strictEqual(yield* fontSize, "12px");
        yield* review.reload;
        assert.strictEqual(yield* fontSize, "12px");
        yield* review.setStyles("");
        assert.strictEqual(yield* fontSize, "40px");

        const full = yield* review.screenshot({ fullPage: true, maxHeight: 1_000 });
        assert.deepStrictEqual([full.width, full.height, full.scrollY], [800, 1_000, 0]);
        assert.strictEqual(yield* review.scrollTo(500), 500);

        yield* Effect.promise(() =>
          page.evaluate(`document.querySelector("h1").textContent = "Ship today"`),
        );
        yield* Deferred.await(mutated);
      }),
    ),
  30_000,
);
