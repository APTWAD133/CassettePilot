export function editorShortcut(event) {
  const key = String(event.key || "").toLowerCase();
  if (!event.ctrlKey && !event.metaKey) {
    if (key === "delete" || key === "backspace") return "delete";
    if (!event.altKey && !event.shiftKey && (key === " " || key === "space" || key === "spacebar")) return "toggle-playback";
    return null;
  }
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  if (key === "c") return "copy";
  if (key === "x") return "cut";
  if (key === "v") return "paste";
  if (key === "a") return "select-all";
  if (key === "d") return "clear-selection";
  return null;
}

export function wheelZoom(currentZoom, deltaY, { min = 1, max = 12, step = 0.25 } = {}) {
  const scaled = Number(currentZoom) * Math.exp(-Number(deltaY) * 0.0025);
  return Math.max(min, Math.min(max, Math.round(scaled / step) * step));
}

export function cursorAnchoredScrollLeft(scrollLeft, pointerX, oldZoom, newZoom, labelWidth = 64) {
  const timelineMs = Math.max(0, (scrollLeft + pointerX - labelWidth) / oldZoom * 1_000);
  return Math.max(0, labelWidth + timelineMs / 1_000 * newZoom - pointerX);
}

export function playheadMsFromPointer(clientX, contentLeft, pixelsPerSecond, totalDurationMs, labelWidth = 64) {
  const rawMs = (Number(clientX) - Number(contentLeft) - labelWidth) / Number(pixelsPerSecond) * 1_000;
  return Math.max(0, Math.min(Number(totalDurationMs) || 0, rawMs));
}
