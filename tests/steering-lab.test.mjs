import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the steering configurator", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Steering Lab/);
  assert.match(html, /ID = A \/ W/);
  assert.match(html, /実寸で試行開始/);
  assert.match(html, /画面設定/);
  assert.match(html, /実寸・ID確認/);
  assert.match(html, /パラメータ設定/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("uses the original experiment's steering ID definition", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const steeringId = config\.amplitudePx \/ Math\.max\(config\.widthPx/);
  assert.match(page, /millimetersPerCssPixel/);
  assert.match(page, /requestFullscreen/);
  assert.match(page, /exitFullscreen/);
  assert.match(page, /startBufferPx:\s*200/);
  assert.match(page, /endBufferPx:\s*200/);
  assert.match(page, /marginPx:\s*88/);
  assert.match(page, /startAreaEndAlong:\s*-startBufferLength/);
  assert.match(page, /endAreaStartAlong:\s*displayLength \+ endBufferLength/);
  assert.match(page, /config\.amplitudePx \+ config\.startBufferPx \+ config\.endBufferPx/);
  assert.match(page, /insideEndpoint\(point, path, "start"\)/);
  assert.match(page, /insideEndpoint\(point, trial\.path, "end"\)/);
  assert.match(page, /coreMovementTimeMs/);
});

test("React fullscreen task keeps a hover parameter drawer over the full canvas", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(css, /\.task-parameter-dock:hover/);
  assert.match(css, /transform:\s*translateX\(-292px\)/);
  assert.match(css, /\.task-stage\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.task-workspace\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/s);
  assert.match(css, /\.task-stage\s*\{[^}]*inset:\s*0;[^}]*padding:\s*0/s);
  assert.match(css, /\.task-toolbar:hover/);
  assert.match(css, /transform:\s*translateY\(calc\(-100% \+ 8px\)\)/);
  assert.match(page, /run-amplitude/);
  assert.match(page, /run-width/);
  assert.match(page, /run-angle/);
  assert.match(page, /run-diagonal/);
  assert.match(page, /run-start-buffer/);
  assert.match(page, /run-end-buffer/);
  assert.match(page, /Core MTには含まれません/);
  assert.match(page, /className="task-surface is-visible"/);
  assert.doesNotMatch(page, /className=\{running \?/);
  assert.match(page, /ブラウザ全画面/);
  assert.match(page, /試行をリセット/);
});
