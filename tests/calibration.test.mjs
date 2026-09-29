import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

async function loadLogic(file, standalone) {
  const content = await readFile(new URL(file, import.meta.url), "utf8");
  const code = standalone ? content.match(/<script>([\s\S]*?)<\/script>/)[1] : content;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, standalone ? ts.ScriptKind.JS : ts.ScriptKind.TSX);
  const functions = new Map();
  const variables = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node)) functions.set(node.name?.text, node.getText(source));
    if (ts.isVariableDeclaration(node)) variables.set(node.name.getText(source), node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const helpers = ["sameEnvironment", "calibrationScale", "referenceMatches"].map(name => functions.get(name)).join("\n");
  const display = standalone ? "displaySettings" : "DISPLAY";
  const metrics = standalone ? functions.get("calculateMetrics") : `function calculateMetrics() { metrics = (${variables.get("metrics").initializer.arguments[0].getText(source)})(); }`;
  const script = `${helpers}\nlet config, environment, metrics;
    const ${display} = ${variables.get(display).initializer.getText(source)};
    ${metrics}
    ({ calibrationScale, referenceMatches, metricsFor(value, current) {
      config = value; environment = current; calculateMetrics(); return metrics;
    } });`;
  return vm.runInNewContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
}

const environment = { screenWidth: 1920, screenHeight: 1080, pixelRatio: 2, viewportScale: 1 };
const calibration = { lineCssPx: 600, measuredMm: 150, environment, calibratedAt: "2026-09-25T00:00:00.000Z" };

for (const [label, file, standalone] of [["React", "../app/page.tsx", false], ["HTML", "../steering_task_configurator.html", true]]) {
  const logic = await loadLogic(file, standalone);
  const config = {
    ...(standalone
      ? { amplitude: 1050, width: 30, angle: 30, diagonal: 24, screenWidth: 3840, screenHeight: 2160 }
      : { amplitudePx: 1050, widthPx: 30, angleDeg: 30, screenDiagonalIn: 24, screenWidthPx: 3840, screenHeightPx: 2160 }),
    startBufferPx: 200, endBufferPx: 200, calibration
  };

  test(`${label}: measured reference corrects A, W and buffers without changing their pixel values`, () => {
    const before = structuredClone(config);
    const metrics = logic.metricsFor(config, environment);
    assert.equal(metrics.calibrated, true);
    assert.equal(metrics.mmPerPx, 0.25);
    assert.equal(metrics.amplitudeMm, 262.5);
    assert.equal(metrics.widthMm, 7.5);
    assert.equal(metrics.startBufferMm, 50);
    assert.equal(metrics.endBufferMm, 50);
    assert.equal(metrics.screenWidthMm, 480);
    assert.equal(metrics.screenHeightMm, 270);
    assert.equal(metrics.screenWidthCssPx, 1920);
    assert.equal(metrics.screenHeightCssPx, 1080);
    assert.deepEqual(config, before);
  });

  test(`${label}: reload preserves the measured ratio and uses the actual reference width`, () => {
    assert.equal(logic.calibrationScale(JSON.parse(JSON.stringify(calibration)), environment), 0.25);
    assert.equal(logic.calibrationScale({ ...calibration, lineCssPx: 320, measuredMm: 80 }, environment), 0.25);
  });

  test(`${label}: changed display size, pixel ratio or pinch zoom stops applying calibration`, () => {
    for (const key of Object.keys(environment)) {
      const changed = { ...environment, [key]: environment[key] * 1.25 };
      assert.equal(logic.calibrationScale(calibration, changed), null);
      const metrics = logic.metricsFor(config, changed);
      assert.equal(metrics.calibrated, false);
      assert.ok(Math.abs(metrics.mmPerPx - 25.4 * 24 / Math.hypot(3840, 2160)) < 1e-12);
    }
  });

  test(`${label}: missing or malformed calibration falls back safely`, () => {
    for (const invalid of [null, {}, "invalid", { ...calibration, environment: null }, { ...calibration, environment: {} }]) {
      assert.equal(logic.calibrationScale(invalid, environment), null);
      assert.equal(logic.metricsFor({ ...config, calibration: invalid }, environment).calibrated, false);
    }
    for (const invalid of [0, -1, NaN, Infinity, "150", null]) {
      assert.equal(logic.calibrationScale({ ...calibration, measuredMm: invalid }, environment), null);
      assert.equal(logic.calibrationScale({ ...calibration, lineCssPx: invalid }, environment), null);
    }
  });

  test(`${label}: calibration cannot save a measurement taken before a reference resize or zoom`, () => {
    assert.equal(logic.referenceMatches(calibration, 600, environment), true);
    assert.equal(logic.referenceMatches(calibration, 500, environment), false);
    assert.equal(logic.referenceMatches(calibration, 600, { ...environment, pixelRatio: 3 }), false);
    assert.equal(logic.referenceMatches(calibration, 0, environment), false);
    assert.equal(logic.referenceMatches(null, 600, environment), false);
  });
}
