"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };

type DisplayEnvironment = {
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  viewportScale: number;
};

type Calibration = {
  lineCssPx: number;
  measuredMm: number;
  environment: DisplayEnvironment;
  calibratedAt: string;
};

type ExperimentConfig = {
  amplitudePx: number;
  widthPx: number;
  angleDeg: number;
  startBufferPx: number;
  endBufferPx: number;
  screenDiagonalIn: number;
  screenWidthPx: number;
  screenHeightPx: number;
  calibration: Calibration | null;
};

type TaskStatus =
  | "ready"
  | "tracking"
  | "success"
  | "retry"
  | "badStart"
  | "nearGoal"
  | "cancelled"
  | "changed";

type TrailPoint = Point & { t: number; outside: boolean; outsidePx: number };

type DeviationEvent = {
  startMs: number;
  startX: number;
  startY: number;
  maxOutsidePx: number;
  endMs: number;
  endX: number;
  endY: number;
  durationMs: number;
};

type TrialResult = {
  success: boolean;
  movementTimeMs: number;
  coreMovementTimeMs: number | null;
  deviationCount: number;
  deviationTotalMs: number;
  maxDeviationPx: number;
  excessiveDeviation: boolean;
  trajectory: TrailPoint[];
  deviationEvents: DeviationEvent[];
};

type Geometry = {
  start: Point;
  end: Point;
  direction: Point;
  displayLength: number;
  displayWidth: number;
  startBufferLength: number;
  endBufferLength: number;
  startAreaStartAlong: number;
  startAreaEndAlong: number;
  coreStartAlong: number;
  coreEndAlong: number;
  endAreaStartAlong: number;
  endAreaEndAlong: number;
  scale: number;
  size: { width: number; height: number };
};

type TrackingTrial = {
  pointerId: number;
  startedAt: number;
  path: Geometry;
  coreEntryMs: number | null;
  coreExitMs: number | null;
  coreMovementTimeMs: number | null;
  lastCoreSample: { elapsed: number; along: number } | null;
  deviationCount: number;
  deviationTotalMs: number;
  maxDeviationPx: number;
  excessiveDeviation: boolean;
  deviationEvents: DeviationEvent[];
  openDeviation: Omit<DeviationEvent, "endMs" | "endX" | "endY" | "durationMs"> | null;
  trajectory: TrailPoint[];
};

const PRESETS = [
  { id: "C1", label: "A固定・W広い", amplitudePx: 1050, widthPx: 30 },
  { id: "C2", label: "A固定・W狭い", amplitudePx: 1050, widthPx: 21 },
  { id: "C3", label: "W固定・A長い", amplitudePx: 1250, widthPx: 25 },
  { id: "C4", label: "W固定・A短い", amplitudePx: 875, widthPx: 25 },
] as const;

const DEFAULT_CONFIG: ExperimentConfig = {
  amplitudePx: 1050,
  widthPx: 30,
  angleDeg: 30,
  startBufferPx: 200,
  endBufferPx: 200,
  screenDiagonalIn: 24,
  screenWidthPx: 1920,
  screenHeightPx: 1080,
  calibration: null,
};

const DISPLAY = Object.freeze({
  marginPx: 88,
  minCorridorWidthPx: 8,
  deviationThresholdPx: 24,
  nearGoalProgressThreshold: 0.9,
});

const STORAGE_KEY = "straight-steering-studio-config-v2";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readEnvironment(): DisplayEnvironment {
  return {
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    pixelRatio: window.devicePixelRatio || 1,
    viewportScale: window.visualViewport?.scale || 1,
  };
}

function sameEnvironment(left: DisplayEnvironment | null, right: DisplayEnvironment | null) {
  return Boolean(left && right && (["screenWidth", "screenHeight", "pixelRatio", "viewportScale"] as const).every((key) =>
    Number.isFinite(left[key]) && left[key] > 0 && Number.isFinite(right[key]) && Math.abs(left[key] - right[key]) < 0.000001,
  ));
}

function calibrationScale(calibration: Calibration | null, environment: DisplayEnvironment | null) {
  if (!calibration || !sameEnvironment(calibration.environment, environment)) return null;
  const { measuredMm, lineCssPx } = calibration;
  const scale = measuredMm / lineCssPx;
  return Number.isFinite(measuredMm) && measuredMm > 0 && Number.isFinite(lineCssPx) && lineCssPx > 0 && Number.isFinite(scale) && scale > 0 ? scale : null;
}

function referenceMatches(reference: { lineCssPx: number; environment: DisplayEnvironment } | null, lineCssPx: number, environment: DisplayEnvironment) {
  return Boolean(reference && lineCssPx > 0 && Math.abs(reference.lineCssPx - lineCssPx) < 0.01 && sameEnvironment(reference.environment, environment));
}

function CalibrationControls({ label, saved, onOpen, onReset }: { label: string; saved: boolean; onOpen: () => void; onReset: () => void }) {
  return <div className="control-card calibration-controls">
    <h3>定規で実寸を校正</h3>
    <p className="calibration-status" role="status">{label}</p>
    <p>基準線を定規で測ると、A・Wのmm表示を補正できます。px指定は変わりません。</p>
    <button type="button" onClick={onOpen}>基準線を測って校正</button>
    {saved && <button type="button" onClick={onReset}>校正を解除</button>}
    <p>使用するモニターと表示倍率で校正してください。同じ解像度の別モニターへの移動は検出できない場合があります。</p>
  </div>;
}

function statusMessage(status: TaskStatus) {
  switch (status) {
    case "tracking":
      return "計測中です。END領域内でポインタを離してください。";
    case "success":
      return "完了しました。START領域から再試行できます。";
    case "retry":
      return "ENDまで到達していません。同じ試行をSTART領域からやり直してください。";
    case "badStart":
      return "START領域内から開始してください。";
    case "nearGoal":
      return "ゴール直前で離されました。分析対象エラーとして記録しました。";
    case "cancelled":
      return "試行をキャンセルしました。";
    case "changed":
      return "パラメータを変更しました。START領域から開始してください。";
    default:
      return "START領域内で押して、END領域内でポインタを離してください。";
  }
}

function pathCoordinates(point: Point, path: Geometry) {
  const dx = point.x - path.start.x;
  const dy = point.y - path.start.y;
  return {
    along: dx * path.direction.x + dy * path.direction.y,
    perpendicular: dx * -path.direction.y + dy * path.direction.x,
  };
}

function visibleAlongRange(path: Geometry) {
  const corners = [
    { x: 0, y: 0 },
    { x: path.size.width, y: 0 },
    { x: path.size.width, y: path.size.height },
    { x: 0, y: path.size.height },
  ].map((point) => pathCoordinates(point, path).along);
  return {
    start: Math.min(...corners) - path.displayWidth,
    end: Math.max(...corners) + path.displayWidth,
  };
}

function insideEndpoint(point: Point, path: Geometry, endpoint: "start" | "end") {
  const coordinates = pathCoordinates(point, path);
  if (Math.abs(coordinates.perpendicular) > path.displayWidth / 2) return false;
  if (endpoint === "start") {
    return (
      coordinates.along >= path.startAreaStartAlong &&
      coordinates.along <= path.startAreaEndAlong
    );
  }
  return (
    coordinates.along >= path.endAreaStartAlong &&
    coordinates.along <= path.endAreaEndAlong
  );
}

function corridorDeviation(point: Point, path: Geometry) {
  const coordinates = pathCoordinates(point, path);
  const outsidePx = Math.max(
    Math.abs(coordinates.perpendicular) - path.displayWidth / 2,
    0,
  );
  return { inside: outsidePx <= 0, outsidePx };
}

function pathProgress(point: Point, path: Geometry) {
  return clamp(pathCoordinates(point, path).along / Math.max(path.displayLength, 1), 0, 1);
}

function pointAlongPath(path: Geometry, along: number) {
  return {
    x: path.start.x + path.direction.x * along,
    y: path.start.y + path.direction.y * along,
  };
}

function drawCorridorSegment(
  context: CanvasRenderingContext2D,
  path: Geometry,
  fromAlong: number,
  toAlong: number,
  fillStyle: string,
  strokeStyle: string,
) {
  const normal = { x: -path.direction.y, y: path.direction.x };
  const half = path.displayWidth / 2;
  const start = pointAlongPath(path, fromAlong);
  const end = pointAlongPath(path, toAlong);
  context.fillStyle = fillStyle;
  context.beginPath();
  context.moveTo(start.x + normal.x * half, start.y + normal.y * half);
  context.lineTo(end.x + normal.x * half, end.y + normal.y * half);
  context.lineTo(end.x - normal.x * half, end.y - normal.y * half);
  context.lineTo(start.x - normal.x * half, start.y - normal.y * half);
  context.closePath();
  context.fill();
  context.strokeStyle = strokeStyle;
  context.lineWidth = 2;
  context.stroke();
}

function interpolateCrossing(
  previous: { elapsed: number; along: number },
  current: { elapsed: number; along: number },
  targetAlong: number,
) {
  const delta = current.along - previous.along;
  const ratio = delta === 0 ? 0 : clamp((targetAlong - previous.along) / delta, 0, 1);
  return previous.elapsed + (current.elapsed - previous.elapsed) * ratio;
}

function recordCoreTiming(trial: TrackingTrial, point: Point, elapsed: number) {
  const current = { elapsed, along: pathCoordinates(point, trial.path).along };
  const previous = trial.lastCoreSample;
  if (!previous) {
    trial.lastCoreSample = current;
    return;
  }
  if (
    trial.coreEntryMs === null &&
    previous.along < trial.path.coreStartAlong &&
    current.along >= trial.path.coreStartAlong
  ) {
    trial.coreEntryMs = Math.round(
      interpolateCrossing(previous, current, trial.path.coreStartAlong),
    );
  }
  if (
    trial.coreEntryMs !== null &&
    trial.coreExitMs === null &&
    previous.along < trial.path.coreEndAlong &&
    current.along >= trial.path.coreEndAlong
  ) {
    trial.coreExitMs = Math.round(
      interpolateCrossing(previous, current, trial.path.coreEndAlong),
    );
    trial.coreMovementTimeMs = Math.max(0, trial.coreExitMs - trial.coreEntryMs);
  }
  trial.lastCoreSample = current;
}

function closeDeviationEvent(trial: TrackingTrial, point: Point, elapsed: number) {
  if (!trial.openDeviation) return;
  const event: DeviationEvent = {
    ...trial.openDeviation,
    endMs: Math.round(elapsed),
    endX: round(point.x, 1),
    endY: round(point.y, 1),
    durationMs: Math.max(0, Math.round(elapsed) - trial.openDeviation.startMs),
  };
  trial.deviationTotalMs += event.durationMs;
  trial.deviationEvents.push(event);
  trial.openDeviation = null;
}

function recordMove(trial: TrackingTrial, point: Point, elapsed: number) {
  recordCoreTiming(trial, point, elapsed);
  const deviation = corridorDeviation(point, trial.path);
  const outsidePx = round(deviation.outsidePx, 1);
  trial.trajectory.push({
    x: round(point.x, 1),
    y: round(point.y, 1),
    t: Math.round(elapsed),
    outside: !deviation.inside,
    outsidePx,
  });
  if (!deviation.inside) {
    trial.maxDeviationPx = Math.max(trial.maxDeviationPx, outsidePx);
    if (outsidePx >= DISPLAY.deviationThresholdPx) trial.excessiveDeviation = true;
    if (!trial.openDeviation) {
      trial.deviationCount += 1;
      trial.openDeviation = {
        startMs: Math.round(elapsed),
        startX: round(point.x, 1),
        startY: round(point.y, 1),
        maxOutsidePx: outsidePx,
      };
    } else {
      trial.openDeviation.maxOutsidePx = Math.max(
        trial.openDeviation.maxOutsidePx,
        outsidePx,
      );
    }
  } else if (trial.openDeviation) {
    closeDeviationEvent(trial, point, elapsed);
  }
}

function SteeringCanvas({
  config,
  interactive = false,
  resetKey = 0,
  onResult,
  onStatusChange,
}: {
  config: ExperimentConfig;
  interactive?: boolean;
  resetKey?: number;
  onResult?: (result: TrialResult) => void;
  onStatusChange?: (status: TaskStatus) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const trackingRef = useRef<TrackingTrial | null>(null);
  const resetSeenRef = useRef(resetKey);
  const [size, setSize] = useState({ width: 1, height: 1 });

  const updateStatus = useCallback(
    (status: TaskStatus) => onStatusChange?.(status),
    [onStatusChange],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      const hostWidth = Math.max(
        1,
        rect.width - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0"),
      );
      const hostHeight = Math.max(
        1,
        rect.height - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0"),
      );
      if (!interactive) {
        setSize({ width: Math.floor(hostWidth), height: Math.floor(hostHeight) });
        return;
      }
      const angle = (config.angleDeg * Math.PI) / 180;
      const totalLength = config.amplitudePx + config.startBufferPx + config.endBufferPx;
      const requiredWidth = Math.ceil(
        Math.abs(Math.cos(angle) * totalLength) + DISPLAY.marginPx * 2,
      );
      const requiredHeight = Math.ceil(
        Math.abs(Math.sin(angle) * totalLength) + DISPLAY.marginPx * 2,
      );
      setSize({
        width: Math.max(Math.floor(hostWidth), requiredWidth),
        height: Math.max(Math.floor(hostHeight), requiredHeight),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [config.amplitudePx, config.angleDeg, config.endBufferPx, config.startBufferPx, interactive]);

  const makePath = useCallback((): Geometry => {
    const angle = (config.angleDeg * Math.PI) / 180;
    const direction = { x: Math.cos(angle), y: -Math.sin(angle) };
    const totalLength = config.amplitudePx + config.startBufferPx + config.endBufferPx;
    const projectedWidth =
      Math.abs(direction.x) * totalLength + Math.abs(direction.y) * config.widthPx;
    const projectedHeight =
      Math.abs(direction.y) * totalLength + Math.abs(direction.x) * config.widthPx;
    const scale = interactive
      ? 1
      : clamp(
          Math.min(
            (size.width - DISPLAY.marginPx * 2) / Math.max(projectedWidth, 1),
            (size.height - DISPLAY.marginPx * 2) / Math.max(projectedHeight, 1),
            1,
          ),
          0.05,
          1,
        );
    const displayLength = config.amplitudePx * scale;
    const displayWidth = Math.max(config.widthPx * scale, DISPLAY.minCorridorWidthPx);
    const startBufferLength = config.startBufferPx * scale;
    const endBufferLength = config.endBufferPx * scale;
    const visibleStartAlong = -startBufferLength;
    const visibleEndAlong = displayLength + endBufferLength;
    const routeMidAlong = (visibleStartAlong + visibleEndAlong) / 2;
    const directionMid = routeMidAlong;
    const start = {
      x: size.width / 2 - direction.x * directionMid,
      y: size.height / 2 - direction.y * directionMid,
    };
    return {
      start,
      end: {
        x: start.x + direction.x * displayLength,
        y: start.y + direction.y * displayLength,
      },
      direction,
      displayLength,
      displayWidth,
      startBufferLength,
      endBufferLength,
      startAreaStartAlong: -Infinity,
      startAreaEndAlong: -startBufferLength,
      coreStartAlong: 0,
      coreEndAlong: displayLength,
      endAreaStartAlong: displayLength + endBufferLength,
      endAreaEndAlong: Infinity,
      scale,
      size,
    };
  }, [config, interactive, size]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 1 || size.height <= 1) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(size.width * dpr));
    const pixelHeight = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const path = makePath();
    geometryRef.current = path;
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = "#d8dce3";
    context.fillRect(0, 0, size.width, size.height);

    const visible = visibleAlongRange(path);
    drawCorridorSegment(context, path, visible.start, path.startAreaEndAlong, "#e8f7ee", "#16794c");
    drawCorridorSegment(context, path, path.startAreaEndAlong, path.endAreaStartAlong, "#eaf1ff", "#2f68c7");
    drawCorridorSegment(context, path, path.endAreaStartAlong, visible.end, "#fff2e3", "#c87300");

    const startLabel = pointAlongPath(path, (visible.start + path.startAreaEndAlong) / 2);
    const endLabel = pointAlongPath(path, (path.endAreaStartAlong + visible.end) / 2);
    context.save();
    context.font = "700 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#16794c";
    context.fillText("START", startLabel.x, startLabel.y);
    context.fillStyle = "#9a6700";
    context.fillText("END", endLabel.x, endLabel.y);
    context.restore();

    const trajectory = trackingRef.current?.trajectory;
    if (interactive && trajectory && trajectory.length > 1) {
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 1.5;
      for (let index = 1; index < trajectory.length; index += 1) {
        const previous = trajectory[index - 1];
        const current = trajectory[index];
        context.strokeStyle = current.outside ? "#d83b32" : "#172033";
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(current.x, current.y);
        context.stroke();
      }
      context.restore();
    }

    context.save();
    context.fillStyle = "rgba(255,255,255,.92)";
    context.strokeStyle = "#d8dee9";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(14, 14, 240, 108, 6);
    context.fill();
    context.stroke();
    context.textAlign = "left";
    context.fillStyle = "#172033";
    context.font = "700 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    context.fillText("CUSTOM 可変条件", 26, 40);
    context.fillStyle = "#647086";
    context.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    context.fillText(
      `A=${config.amplitudePx} / W=${config.widthPx} / ID=${round(config.amplitudePx / config.widthPx, 3)}`,
      26,
      62,
    );
    context.fillText(
      `Buffer START=${config.startBufferPx} / END=${config.endBufferPx}px`,
      26,
      82,
    );
    context.fillText(interactive ? "表示: 実寸ピクセル" : `表示倍率 ${round(path.scale, 3)}`, 26, 102);
    context.restore();
  }, [config, interactive, makePath, size]);

  useEffect(() => draw(), [draw]);

  useEffect(() => {
    if (!interactive || resetSeenRef.current === resetKey) return;
    resetSeenRef.current = resetKey;
    const canvas = canvasRef.current;
    const trial = trackingRef.current;
    if (canvas && trial && canvas.hasPointerCapture(trial.pointerId)) {
      canvas.releasePointerCapture(trial.pointerId);
    }
    trackingRef.current = null;
    draw();
  }, [draw, interactive, resetKey]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const path = geometryRef.current;
    if (!interactive || !path) return;
    const point = pointFromEvent(event);
    if (!insideEndpoint(point, path, "start")) {
      updateStatus("badStart");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const trial: TrackingTrial = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      path,
      coreEntryMs: null,
      coreExitMs: null,
      coreMovementTimeMs: null,
      lastCoreSample: null,
      deviationCount: 0,
      deviationTotalMs: 0,
      maxDeviationPx: 0,
      excessiveDeviation: false,
      deviationEvents: [],
      openDeviation: null,
      trajectory: [
        { x: round(point.x, 1), y: round(point.y, 1), t: 0, outside: false, outsidePx: 0 },
      ],
    };
    recordCoreTiming(trial, point, 0);
    trackingRef.current = trial;
    updateStatus("tracking");
    draw();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const trial = trackingRef.current;
    if (!interactive || !trial || trial.pointerId !== event.pointerId) return;
    recordMove(trial, pointFromEvent(event), performance.now() - trial.startedAt);
    draw();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const trial = trackingRef.current;
    if (!interactive || !trial || trial.pointerId !== event.pointerId) return;
    const point = pointFromEvent(event);
    const elapsed = performance.now() - trial.startedAt;
    recordCoreTiming(trial, point, elapsed);
    if (trial.openDeviation) closeDeviationEvent(trial, point, elapsed);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const success = insideEndpoint(point, trial.path, "end");
    const progress = pathProgress(point, trial.path);
    if (success || progress >= DISPLAY.nearGoalProgressThreshold) {
      onResult?.({
        success,
        movementTimeMs: Math.round(elapsed),
        coreMovementTimeMs: trial.coreMovementTimeMs,
        deviationCount: trial.deviationCount,
        deviationTotalMs: Math.round(trial.deviationTotalMs),
        maxDeviationPx: trial.maxDeviationPx,
        excessiveDeviation: trial.excessiveDeviation,
        trajectory: trial.trajectory,
        deviationEvents: trial.deviationEvents,
      });
      updateStatus(success ? "success" : "nearGoal");
    } else {
      updateStatus("retry");
    }
    trackingRef.current = null;
    draw();
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const trial = trackingRef.current;
    if (!interactive || !trial) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    trackingRef.current = null;
    updateStatus("cancelled");
    draw();
  };

  return (
    <canvas
      ref={canvasRef}
      className={interactive ? "task-canvas is-interactive" : "task-canvas"}
      style={{ width: `${size.width}px`, height: `${size.height}px` }}
      aria-label={interactive ? "直線ステアリング課題" : "設定中の直線課題プレビュー"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    />
  );
}

function NumberField({ id, label, value, unit, min, max, step = 1, onChange }: {
  id: string;
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(String(value));
  }, [value]);

  const commitValue = () => {
    editingRef.current = false;
    const parsed = draft.trim() === "" ? 0 : Number(draft);
    const committed = clamp(Number.isFinite(parsed) ? parsed : value, min, max);
    setDraft(String(committed));
    onChange(committed);
  };

  return (
    <label className="number-field" htmlFor={id}>
      <span>{label}</span>
      <span className="number-input-wrap">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={draft}
          data-min={min}
          data-max={max}
          data-step={step}
          onFocus={() => { editingRef.current = true; }}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            const parsed = raw.trim() === "" ? 0 : Number(raw);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={commitValue}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              editingRef.current = false;
              setDraft(String(value));
              event.currentTarget.blur();
            }
          }}
        />
        <b>{unit}</b>
      </span>
    </label>
  );
}

export default function Home() {
  const [config, setConfig] = useState<ExperimentConfig>(DEFAULT_CONFIG);
  const [activeTab, setActiveTab] = useState<"task" | "screen" | "measure">("task");
  const [fullscreen, setFullscreen] = useState(false);
  const [drawerPinned, setDrawerPinned] = useState(false);
  const [drawerDismissed, setDrawerDismissed] = useState(false);
  const [parameterTab, setParameterTab] = useState<"task" | "buffer" | "screen">("task");
  const [taskStatus, setTaskStatus] = useState<TaskStatus>("ready");
  const [lastResult, setLastResult] = useState<TrialResult | null>(null);
  const [trialResetKey, setTrialResetKey] = useState(0);
  const [environment, setEnvironment] = useState<DisplayEnvironment | null>(null);
  const [calibrationDraft, setCalibrationDraft] = useState("");
  const [calibrationError, setCalibrationError] = useState("");
  const appShellRef = useRef<HTMLElement>(null);
  const taskSurfaceRef = useRef<HTMLDivElement>(null);
  const calibrationDialogRef = useRef<HTMLDialogElement>(null);
  const calibrationLineRef = useRef<HTMLDivElement>(null);
  const calibrationSession = useRef<{ lineCssPx: number; environment: DisplayEnvironment } | null>(null);

  const checkDisplay = useCallback(() => {
    const next = readEnvironment();
    setEnvironment((current) => sameEnvironment(current, next) ? current : next);
    if (!calibrationDialogRef.current?.open || !calibrationSession.current) return;
    const lineCssPx = calibrationLineRef.current?.getBoundingClientRect().width ?? 0;
    if (!referenceMatches(calibrationSession.current, lineCssPx, next)) {
      calibrationSession.current = { lineCssPx, environment: next };
      setCalibrationDraft("");
      setCalibrationError("表示サイズ・倍率が変わりました。現在の基準線をもう一度測ってください。");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(checkDisplay, 0);
    const timer = window.setInterval(checkDisplay, 1000);
    window.addEventListener("resize", checkDisplay);
    window.addEventListener("focus", checkDisplay);
    window.visualViewport?.addEventListener("resize", checkDisplay);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("resize", checkDisplay);
      window.removeEventListener("focus", checkDisplay);
      window.visualViewport?.removeEventListener("resize", checkDisplay);
    };
  }, [checkDisplay]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const savedConfig = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
        window.setTimeout(() => setConfig(savedConfig), 0);
      } else if (window.screen.width && window.screen.height) {
        const detectedConfig = {
          ...DEFAULT_CONFIG,
          screenWidthPx: window.screen.width,
          screenHeightPx: window.screen.height,
        };
        window.setTimeout(() => setConfig(detectedConfig), 0);
      }
    } catch {
      // The page remains usable when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // The page remains usable without persistence.
    }
  }, [config]);

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const metrics = useMemo(() => {
    const diagonalPx = Math.hypot(config.screenWidthPx, config.screenHeightPx);
    const estimatedPpi = diagonalPx / Math.max(config.screenDiagonalIn, 0.1);
    const calibratedScale = calibrationScale(config.calibration, environment);
    const mmPerPx = calibratedScale ?? 25.4 / estimatedPpi;
    const pixelsPerInch = 25.4 / mmPerPx;
    const screenWidth = calibratedScale !== null && environment ? environment.screenWidth : config.screenWidthPx;
    const screenHeight = calibratedScale !== null && environment ? environment.screenHeight : config.screenHeightPx;
    const steeringId = config.amplitudePx / Math.max(config.widthPx, 0.1);
    const angle = (config.angleDeg * Math.PI) / 180;
    const totalLength = config.amplitudePx + config.startBufferPx + config.endBufferPx;
    const requiredWidth = Math.abs(Math.cos(angle)) * totalLength + Math.abs(Math.sin(angle)) * config.widthPx + DISPLAY.marginPx * 2;
    const requiredHeight = Math.abs(Math.sin(angle)) * totalLength + Math.abs(Math.cos(angle)) * config.widthPx + DISPLAY.marginPx * 2;
    return {
      pixelsPerInch,
      mmPerPx,
      calibrated: calibratedScale !== null,
      screenWidthCssPx: screenWidth,
      screenHeightCssPx: screenHeight,
      steeringId,
      amplitudeMm: config.amplitudePx * mmPerPx,
      widthMm: config.widthPx * mmPerPx,
      startBufferMm: config.startBufferPx * mmPerPx,
      endBufferMm: config.endBufferPx * mmPerPx,
      totalRoutePx: totalLength,
      screenWidthMm: screenWidth * mmPerPx,
      screenHeightMm: screenHeight * mmPerPx,
      screenDiagonalMm: Math.hypot(screenWidth, screenHeight) * mmPerPx,
      fitsScreen: requiredWidth <= screenWidth && requiredHeight <= screenHeight,
      requiredWidth: Math.ceil(requiredWidth),
      requiredHeight: Math.ceil(requiredHeight),
    };
  }, [config, environment]);

  const calibrationLabel = metrics.calibrated ? "実測校正済み" : config.calibration ? "要再校正：画面・倍率を確認してください（現在は推定値）" : "未校正：画面設定からの推定値";

  const updateConfig = useCallback((updates: Partial<ExperimentConfig>) => {
    setConfig((current) => ({ ...current, ...updates }));
    setLastResult(null);
    setTaskStatus("changed");
    setTrialResetKey((key) => key + 1);
  }, []);

  const setValue = (key: keyof ExperimentConfig, value: number) => updateConfig({ [key]: value });
  const useDetectedScreen = () => updateConfig({ screenWidthPx: window.screen.width, screenHeightPx: window.screen.height });

  const toggleAppFullscreen = async () => {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { return; }
    } else if (appShellRef.current?.requestFullscreen) {
      void appShellRef.current.requestFullscreen().catch(() => undefined);
    }
  };

  const enterTaskFullscreen = () => {
    if (!document.fullscreenElement && taskSurfaceRef.current?.requestFullscreen) {
      void taskSurfaceRef.current.requestFullscreen().catch(() => undefined);
    }
  };

  const beginTask = () => {
    setLastResult(null);
    setTaskStatus("ready");
    setDrawerPinned(false);
    window.setTimeout(enterTaskFullscreen, 0);
  };

  const leaveFullscreen = async () => {
    if (document.fullscreenElement && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch { return; }
    }
  };

  const resetTrial = () => {
    setLastResult(null);
    setTaskStatus("ready");
    setTrialResetKey((key) => key + 1);
  };

  const openCalibration = () => {
    resetTrial();
    setCalibrationDraft("");
    setCalibrationError("");
    calibrationDialogRef.current?.showModal();
    calibrationSession.current = {
      lineCssPx: calibrationLineRef.current?.getBoundingClientRect().width ?? 0,
      environment: readEnvironment(),
    };
  };

  const applyCalibration = () => {
    const next = readEnvironment();
    const lineCssPx = calibrationLineRef.current?.getBoundingClientRect().width ?? 0;
    if (!referenceMatches(calibrationSession.current, lineCssPx, next)) {
      checkDisplay();
      return;
    }
    const calibration = { lineCssPx, measuredMm: Number(calibrationDraft), environment: next, calibratedAt: new Date().toISOString() };
    if (calibrationDraft.trim() === "" || calibrationScale(calibration, next) === null) {
      setCalibrationError("定規で測った長さを、0より大きいmmの数値で入力してください。");
      return;
    }
    setEnvironment(next);
    updateConfig({ calibration });
    calibrationDialogRef.current?.close();
  };

  const exportConfig = () => {
    const payload = {
      appName: "直線ステアリング課題設定",
      task: {
        shape: "straight",
        amplitude: config.amplitudePx,
        width: config.widthPx,
        steeringId: round(metrics.steeringId, 3),
        angleDeg: config.angleDeg,
        startBufferPx: config.startBufferPx,
        endBufferPx: config.endBufferPx,
        exactPixels: true,
      },
      display: {
        diagonalInches: config.screenDiagonalIn,
        screenWidthCssPx: metrics.screenWidthCssPx,
        screenHeightCssPx: metrics.screenHeightCssPx,
        pixelsPerInch: round(metrics.pixelsPerInch, 3),
        millimetersPerCssPixel: round(metrics.mmPerPx, 5),
        measurementSource: metrics.calibrated ? "ruler" : "estimated",
        calibration: config.calibration,
      },
      physicalSize: { amplitudeMm: round(metrics.amplitudeMm, 2), widthMm: round(metrics.widthMm, 2) },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `steering_A${config.amplitudePx}_W${config.widthPx}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleTaskStatus = (status: TaskStatus) => {
    if (["tracking", "retry", "badStart", "cancelled"].includes(status)) setLastResult(null);
    setTaskStatus(status);
  };

  return (
    <main ref={appShellRef} className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">SL</div>
        <div className="app-title"><p>STEERING EXPERIMENT</p><h1>直線ステアリング課題設定</h1></div>
        <div className="status-strip" aria-label="現在の設定">
          <span><i>A</i><b>{config.amplitudePx} px</b></span>
          <span><i>W</i><b>{config.widthPx} px</b></span>
          <span><i>ID</i><b>{round(metrics.steeringId, 3)}</b></span>
          <span><i>A実寸</i><b>{round(metrics.amplitudeMm, 1)} mm</b></span>
          <span><i>W実寸</i><b>{round(metrics.widthMm, 1)} mm</b></span>
          <span><i>密度</i><b>{round(metrics.pixelsPerInch, 1)} ppi</b></span>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => void toggleAppFullscreen()}>{fullscreen ? "全画面解除" : "全画面"}</button>
          <button type="button" onClick={exportConfig}>JSON保存</button>
        </div>
      </header>

      <nav className="tabs" aria-label="設定項目">
        {([["task", "課題設定"], ["screen", "画面設定"], ["measure", "実寸・ID確認"]] as const).map(([id, label]) => (
          <button key={id} type="button" className={activeTab === id ? "tab is-active" : "tab"} onClick={() => setActiveTab(id)}>{label}</button>
        ))}
      </nav>

      <div className="workspace">
        <aside className="controls">
          {activeTab === "task" && (
            <section className="tab-panel">
              <div className="panel-title"><h2>課題設定</h2><p>A・W・直線角度を変更すると、右のプレビューへ即時反映されます。</p></div>
              <div className="control-card">
                <h3>既存条件プリセット</h3>
                <div className="preset-row" aria-label="既存条件プリセット">
                  {PRESETS.map((preset) => (
                    <button key={preset.id} type="button" className={config.amplitudePx === preset.amplitudePx && config.widthPx === preset.widthPx ? "preset-button is-active" : "preset-button"} title={preset.label} onClick={() => updateConfig({ amplitudePx: preset.amplitudePx, widthPx: preset.widthPx })}>{preset.id}</button>
                  ))}
                </div>
                <div className="field-grid">
                  <NumberField id="amplitude" label="A · 移動距離" value={config.amplitudePx} unit="px" min={40} max={4000} onChange={(value) => setValue("amplitudePx", value)} />
                  <NumberField id="width" label="W · 通路幅" value={config.widthPx} unit="px" min={8} max={600} onChange={(value) => setValue("widthPx", value)} />
                </div>
                <div className="formula-box"><span>ID = A / W</span><strong>{config.amplitudePx} / {config.widthPx} = {round(metrics.steeringId, 3)}</strong></div>
              </div>
              <div className="control-card">
                <h3>形状</h3>
                <label className="number-field"><span>課題形状</span><span className="number-input-wrap disabled-input"><input value="直線 / Straight" disabled readOnly /><b>固定</b></span></label>
                <div className="range-field">
                  <span className="range-field-head"><label htmlFor="angle">直線の角度</label><output>{config.angleDeg}°</output></span>
                  <input id="angle" type="range" min="0" max="180" step="1" value={config.angleDeg} onChange={(event) => setValue("angleDeg", Number(event.target.value))} />
                </div>
              </div>
            </section>
          )}

          {activeTab === "screen" && (
            <section className="tab-panel">
              <div className="panel-title"><h2>画面設定</h2><p>使用するモニターの対角インチとブラウザ上の画面サイズを設定します。</p></div>
              <CalibrationControls label={calibrationLabel} saved={Boolean(config.calibration)} onOpen={openCalibration} onReset={() => updateConfig({ calibration: null })} />
              <div className="control-card field-stack">
                <NumberField id="diagonal" label="画面の対角サイズ" value={config.screenDiagonalIn} unit="inch" min={5} max={100} step={0.1} onChange={(value) => setValue("screenDiagonalIn", value)} />
                <div className="field-grid">
                  <NumberField id="screen-width" label="画面の横" value={config.screenWidthPx} unit="CSS px" min={320} max={10000} onChange={(value) => setValue("screenWidthPx", value)} />
                  <NumberField id="screen-height" label="画面の縦" value={config.screenHeightPx} unit="CSS px" min={240} max={10000} onChange={(value) => setValue("screenHeightPx", value)} />
                </div>
                <button className="text-button" type="button" onClick={useDetectedScreen}>この画面のサイズを自動取得</button>
                <p className="calibration-note">未校正時の推定に使用します。対角インチはモニター仕様、縦横はブラウザが取得するCSS pxを入力してください。</p>
              </div>
              <div className="control-card"><h3>算出した画面実寸</h3><div className="screen-size">
                <div><span>画面横</span><b>{round(metrics.screenWidthMm, 1)} mm</b></div>
                <div><span>画面縦</span><b>{round(metrics.screenHeightMm, 1)} mm</b></div>
                <div><span>対角</span><b>{round(metrics.screenDiagonalMm, 1)} mm</b></div>
              </div></div>
            </section>
          )}

          {activeTab === "measure" && (
            <section className="tab-panel">
              <div className="panel-title"><h2>実寸・ID確認</h2><p>現在設定している課題の実寸値と計算方法です。</p></div>
              <div className="measure-stack">
                <div className="measure-card"><span>A · 移動距離</span><strong>{round(metrics.amplitudeMm, 2)}<small> mm</small></strong></div>
                <div className="measure-card"><span>W · 通路幅</span><strong>{round(metrics.widthMm, 2)}<small> mm</small></strong></div>
                <div className="measure-card"><span>STEERING ID · A / W</span><strong>{round(metrics.steeringId, 3)}</strong></div>
                <div className="measure-card"><span>1 CSS px</span><strong>{round(metrics.mmPerPx, 3)}<small> mm</small></strong></div>
              </div>
              <div className="calculation"><b>{calibrationLabel}</b><br />{metrics.calibrated ? "mm/px = 基準線の実測mm ÷ 基準線のCSS px" : "mm/px = 25.4 × 対角インチ ÷ √(画面横² + 画面縦²)"}<br />A実寸 = A × mm/px ／ W実寸 = W × mm/px</div>
            </section>
          )}
        </aside>

        <section className="preview">
          <div className="preview-head"><h2>直線課題プレビュー</h2><span className={metrics.fitsScreen ? "fit-badge is-ok" : "fit-badge is-warning"}>{metrics.fitsScreen ? "● 全画面に実寸で収まります" : "▲ 画面サイズを超えます"}</span></div>
          <div className="canvas-box">
            <SteeringCanvas config={config} />
            <span className="preview-scale">設定プレビュー · 全画面試行は1設定px = 1CSS px</span>
            {!metrics.fitsScreen && <p className="fit-warning">必要領域の目安は {metrics.requiredWidth} × {metrics.requiredHeight} CSS pxです。</p>}
          </div>
          <div className="preview-footer">
            <div className="actuals">
              <div><span>A実寸</span><b>{round(metrics.amplitudeMm, 2)} <small>mm</small></b></div>
              <div><span>W実寸</span><b>{round(metrics.widthMm, 2)} <small>mm</small></b></div>
              <div><span>ANGLE</span><b>{config.angleDeg}<small>°</small></b></div>
            </div>
            <button className="primary-action" type="button" onClick={beginTask}>実寸で試行開始</button>
          </div>
        </section>
      </div>

      <footer className="bottom-bar"><span>● 設定変更はプレビューへ即時反映</span><span>上部タブで設定を切替 · Escで全画面解除 · 設定は自動保存</span></footer>

      <div ref={taskSurfaceRef} className="task-surface is-visible">
        <div className="task-toolbar">
          <div className="task-readout"><span>STRAIGHT TASK</span><b>A {config.amplitudePx}px</b><b>W {config.widthPx}px</b><b>ID {round(metrics.steeringId, 3)}</b><b>BUFFER {config.startBufferPx} / {config.endBufferPx}px</b><b>{round(metrics.amplitudeMm, 1)} × {round(metrics.widthMm, 1)} mm（{metrics.calibrated ? "校正済" : "推定"}）</b></div>
          <div className="task-actions">
            {!fullscreen && <button type="button" onClick={enterTaskFullscreen}>ブラウザ全画面</button>}
            <button type="button" onClick={() => void leaveFullscreen()} disabled={!fullscreen}>全画面解除</button>
            <button className="task-stop" type="button" onClick={resetTrial}>試行をリセット</button>
          </div>
        </div>
        <div className="task-workspace">
          <div
            className={`task-parameter-dock${drawerPinned ? " is-open" : ""}${drawerDismissed ? " is-dismissed" : ""}`}
            onMouseLeave={() => setDrawerDismissed(false)}
          >
            <aside className="task-parameters" aria-label="全画面課題のパラメータ設定">
              <div className="task-parameters-head">
                <h2>パラメータ設定</h2>
                <button
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.blur();
                    setDrawerPinned(false);
                    setDrawerDismissed(true);
                  }}
                  aria-label="パラメータ設定を閉じる"
                >
                  閉じる
                </button>
              </div>
              <p>カーソルを外すと閉じます。変更時は進行中の試行だけをキャンセルします。</p>
              <div className="parameter-tabs" role="tablist" aria-label="パラメータの種類">
                {([["task", "課題"], ["buffer", "バッファ"], ["screen", "画面"]] as const).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={parameterTab === id} className={parameterTab === id ? "parameter-tab is-active" : "parameter-tab"} onClick={() => setParameterTab(id)}>{label}</button>
                ))}
              </div>

              {parameterTab === "task" && <div role="tabpanel" className="parameter-tab-panel">
                <div className="preset-row" aria-label="既存条件プリセット">
                  {PRESETS.map((preset) => (
                    <button key={`run-${preset.id}`} type="button" className={config.amplitudePx === preset.amplitudePx && config.widthPx === preset.widthPx ? "preset-button is-active" : "preset-button"} title={preset.label} onClick={() => updateConfig({ amplitudePx: preset.amplitudePx, widthPx: preset.widthPx })}>{preset.id}</button>
                  ))}
                </div>
                <div className="control-card">
                  <h3>直線課題</h3>
                  <div className="field-grid">
                    <NumberField id="run-amplitude" label="A · Core MT区間" value={config.amplitudePx} unit="px" min={40} max={4000} onChange={(value) => setValue("amplitudePx", value)} />
                    <NumberField id="run-width" label="W · 通路幅" value={config.widthPx} unit="px" min={8} max={600} onChange={(value) => setValue("widthPx", value)} />
                  </div>
                  <div className="range-field"><span className="range-field-head"><label htmlFor="run-angle">直線の角度</label><output>{config.angleDeg}°</output></span><input id="run-angle" type="range" min="0" max="180" step="1" value={config.angleDeg} onChange={(event) => setValue("angleDeg", Number(event.target.value))} /></div>
                </div>
              </div>}

              {parameterTab === "buffer" && <div role="tabpanel" className="parameter-tab-panel">
                <div className="control-card field-stack buffer-card">
                  <h3>Core MTに含めない区間</h3>
                  <NumberField id="run-start-buffer" label="START側バッファ" value={config.startBufferPx} unit="px" min={0} max={2000} onChange={(value) => setValue("startBufferPx", value)} />
                  <NumberField id="run-end-buffer" label="END側バッファ" value={config.endBufferPx} unit="px" min={0} max={2000} onChange={(value) => setValue("endBufferPx", value)} />
                  <p className="buffer-note">Core MTは青いコア区間Aだけで算出します。START側とEND側のバッファは全体MTには含まれますが、Core MTには含まれません。</p>
                </div>
                <div className="buffer-summary" aria-label="経路区間の内訳">
                  <div><span>START BUFFER</span><b>{config.startBufferPx}px</b><small>{round(metrics.startBufferMm, 2)} mm</small></div>
                  <div className="is-core"><span>CORE A</span><b>{config.amplitudePx}px</b><small>Core MT対象</small></div>
                  <div><span>END BUFFER</span><b>{config.endBufferPx}px</b><small>{round(metrics.endBufferMm, 2)} mm</small></div>
                </div>
                <div className="route-total"><span>経路合計</span><b>{metrics.totalRoutePx} px</b></div>
              </div>}

              {parameterTab === "screen" && <div role="tabpanel" className="parameter-tab-panel">
                <CalibrationControls label={calibrationLabel} saved={Boolean(config.calibration)} onOpen={openCalibration} onReset={() => updateConfig({ calibration: null })} />
                <div className="control-card field-stack">
                  <h3>画面設定</h3>
                  <NumberField id="run-diagonal" label="対角サイズ" value={config.screenDiagonalIn} unit="inch" min={5} max={100} step={0.1} onChange={(value) => setValue("screenDiagonalIn", value)} />
                  <div className="field-grid">
                    <NumberField id="run-screen-width" label="画面の横" value={config.screenWidthPx} unit="CSS px" min={320} max={10000} onChange={(value) => setValue("screenWidthPx", value)} />
                    <NumberField id="run-screen-height" label="画面の縦" value={config.screenHeightPx} unit="CSS px" min={240} max={10000} onChange={(value) => setValue("screenHeightPx", value)} />
                  </div>
                  <button className="text-button" type="button" onClick={useDetectedScreen}>この画面のサイズを自動取得</button>
                  <p className="calibration-note">未校正時の推定に使用します。</p>
                </div>
              </div>}
              <p className="calibration-status" role="status">{calibrationLabel}</p>
              <div className="run-actuals">
                <div><span>A実寸</span><b>{round(metrics.amplitudeMm, 2)} mm</b></div><div><span>W実寸</span><b>{round(metrics.widthMm, 2)} mm</b></div><div><span>ID = A / W</span><b>{round(metrics.steeringId, 3)}</b></div><div><span>1 CSS px</span><b>{round(metrics.mmPerPx, 3)} mm</b></div>
              </div>
            </aside>
            <button
              className="task-parameter-handle"
              type="button"
              aria-label={drawerPinned ? "パラメータ設定を閉じる" : "パラメータ設定を開いたまま固定"}
              aria-expanded={drawerPinned}
              title={drawerPinned ? "クリックして閉じる" : "カーソルを合わせると設定を表示"}
              onClick={(event) => {
                if (drawerPinned) {
                  event.currentTarget.blur();
                  setDrawerPinned(false);
                  setDrawerDismissed(true);
                  return;
                }
                setDrawerDismissed(false);
                setDrawerPinned(true);
              }}
            >
              {drawerPinned ? "閉じる" : "設定"}
            </button>
          </div>
          <div className="task-stage"><SteeringCanvas config={config} interactive resetKey={trialResetKey} onStatusChange={handleTaskStatus} onResult={setLastResult} /></div>
        </div>
        <div className={`task-message tone-${taskStatus}`} role="status" aria-live="polite">
          <span>{statusMessage(taskStatus)}</span>
          {lastResult && <b>全体MT {lastResult.movementTimeMs} ms · コアMT {lastResult.coreMovementTimeMs ?? "—"} ms · 逸脱 {lastResult.deviationCount} 回</b>}
        </div>
        <dialog ref={calibrationDialogRef} className="calibration-dialog" aria-labelledby="calibration-title" onClose={() => { calibrationSession.current = null; }}>
          <form onSubmit={(event) => { event.preventDefault(); applyCalibration(); }}>
            <h2 id="calibration-title">定規で実寸を校正</h2>
            <p>左右の縦線の中心間を、画面に当てた定規で測ってください。測定中はウィンドウサイズ・ズームを変えないでください。</p>
            <div className="calibration-reference"><div ref={calibrationLineRef} className="calibration-line"><span /></div></div>
            <label className="calibration-input" htmlFor="calibration-mm">測った長さ（mm）<input id="calibration-mm" type="number" min="0.01" step="any" required value={calibrationDraft} onChange={(event) => setCalibrationDraft(event.target.value)} /></label>
            <p className="calibration-error" role="alert">{calibrationError}</p>
            <p>例：15.2 cmなら152 mm。保存後は同じ表示環境で校正値を使用します。精度は定規の読み取り精度に依存します。</p>
            <div className="calibration-actions"><button type="button" onClick={() => calibrationDialogRef.current?.close()}>キャンセル</button><button type="submit">校正を保存</button></div>
          </form>
        </dialog>
      </div>
    </main>
  );
}
