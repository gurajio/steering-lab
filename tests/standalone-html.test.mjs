import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const htmlUrl = new URL("../steering_task_configurator.html", import.meta.url);

test("standalone HTML has no runtime dependencies and valid script syntax", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);

  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.indexOf("</script>", start);
  assert.ok(start >= "<script>".length && end > start);
  assert.doesNotThrow(() => new Function(html.slice(start, end)));
});

test("standalone HTML calculates physical A and W and supports fullscreen cancellation", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /const mmPerPx = 25\.4 \/ ppi/);
  assert.match(html, /amplitudeMm: config\.amplitude \* mmPerPx/);
  assert.match(html, /widthMm: config\.width \* mmPerPx/);
  assert.match(html, /requestFullscreen/);
  assert.match(html, /exitFullscreen/);
  assert.match(html, /試行を終了/);
});

test("standalone task preserves the attached experiment geometry and interaction rules", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /movementAreaPx:\s*200/);
  assert.match(html, /marginPx:\s*88/);
  assert.match(html, /minCorridorWidthPx:\s*8/);
  assert.match(html, /startAreaEndAlong:\s*-movementAreaLength/);
  assert.match(html, /endAreaStartAlong:\s*displayLength \+ movementAreaLength/);
  assert.match(html, /isInsideEndpointZone\(point, taskGeometry, "start"\)/);
  assert.match(html, /isInsideEndpointZone\(point, trial\.path, "end"\)/);
  assert.match(html, /getCorridorDeviation\(point, trial\.path\)/);
  assert.match(html, /coreMovementTimeMs/);
  assert.match(html, /"#e8f7ee", "#16794c"/);
  assert.match(html, /"#eaf1ff", "#2f68c7"/);
  assert.match(html, /"#fff2e3", "#c87300"/);
});

test("fullscreen task includes editable A, W, angle and display parameters", async () => {
  const html = await readFile(htmlUrl, "utf8");
  for (const id of [
    "runAmplitude",
    "runWidthInput",
    "runAngle",
    "runDiagonal",
    "runScreenWidth",
    "runScreenHeight"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /elements\.appShell\.append\(elements\.taskOverlay\)/);
  assert.match(html, /\.task-parameter-dock:hover/);
  assert.match(html, /transform:\s*translateX\(-292px\)/);
  assert.match(html, /id="taskParameterHandle"/);
  assert.match(html, /\.task-stage\s*\{[\s\S]*?position:\s*absolute/);
});
