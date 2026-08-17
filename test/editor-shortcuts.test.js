import test from "node:test";
import assert from "node:assert/strict";
import { cursorAnchoredScrollLeft, editorShortcut, playheadMsFromPointer, wheelZoom } from "../src/editor-shortcuts.js";

test("Windows editing shortcuts map to timeline commands", () => {
  assert.equal(editorShortcut({ ctrlKey: true, key: "z" }), "undo");
  assert.equal(editorShortcut({ ctrlKey: true, key: "y" }), "redo");
  assert.equal(editorShortcut({ ctrlKey: true, key: "c" }), "copy");
  assert.equal(editorShortcut({ ctrlKey: true, key: "x" }), "cut");
  assert.equal(editorShortcut({ ctrlKey: true, key: "v" }), "paste");
  assert.equal(editorShortcut({ ctrlKey: true, key: "a" }), "select-all");
  assert.equal(editorShortcut({ ctrlKey: true, key: "d" }), "clear-selection");
});

test("Space toggles editor playback without hijacking modified Space", () => {
  assert.equal(editorShortcut({ key: " " }), "toggle-playback");
  assert.equal(editorShortcut({ key: "Space" }), "toggle-playback");
  assert.equal(editorShortcut({ key: "Spacebar" }), "toggle-playback");
  assert.equal(editorShortcut({ shiftKey: true, key: " " }), null);
  assert.equal(editorShortcut({ ctrlKey: true, key: " " }), null);
});

test("shifted undo and macOS aliases map to redo", () => {
  assert.equal(editorShortcut({ ctrlKey: true, shiftKey: true, key: "z" }), "redo");
  assert.equal(editorShortcut({ metaKey: true, shiftKey: true, key: "Z" }), "redo");
});

test("unmodified keys are left to the browser", () => {
  assert.equal(editorShortcut({ key: "c" }), null);
  assert.equal(editorShortcut({ key: "a" }), null);
});

test("Delete and Backspace remove the selected timeline clip", () => {
  assert.equal(editorShortcut({ key: "Delete" }), "delete");
  assert.equal(editorShortcut({ key: "Backspace" }), "delete");
  assert.equal(editorShortcut({ ctrlKey: true, key: "Backspace" }), null);
});

test("control-wheel zoom remains stepped, bounded, and anchored under the cursor", () => {
  assert.equal(wheelZoom(4, -200), 6.5);
  assert.equal(wheelZoom(11.75, -1_000), 12);
  assert.equal(wheelZoom(1.25, 1_000), 1);

  const previousScrollLeft = 600;
  const pointerX = 400;
  const oldZoom = 4;
  const newZoom = 6.5;
  const beforeMs = (previousScrollLeft + pointerX - 64) / oldZoom * 1_000;
  const nextScrollLeft = cursorAnchoredScrollLeft(previousScrollLeft, pointerX, oldZoom, newZoom);
  const afterMs = (nextScrollLeft + pointerX - 64) / newZoom * 1_000;
  assert.equal(afterMs, beforeMs);
});

test("ruler pointer positions map to a clamped playhead time", () => {
  assert.equal(playheadMsFromPointer(464, 100, 4, 120_000), 75_000);
  assert.equal(playheadMsFromPointer(120, 100, 4, 120_000), 0);
  assert.equal(playheadMsFromPointer(900, 100, 4, 120_000), 120_000);
});
