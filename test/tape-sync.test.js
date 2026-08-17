import test from "node:test";
import assert from "node:assert/strict";
import { TapeSynchronizer } from "../src/tape-sync.js";

const frame = { trackId: "186016", timelineMs: 42_000 };

test("first valid tape frame relocates immediately before playback can start", () => {
  const sync = new TapeSynchronizer();
  const decision = sync.accept(frame, {
    playheadMs: 39_000,
    currentTrackId: "186016",
    totalDurationMs: 120_000
  });
  assert.deepEqual(decision, {
    relocate: true,
    targetMs: 42_000,
    acquired: true,
    reason: "acquisition"
  });
});

test("normal tape drift is ignored after acquisition", () => {
  const sync = new TapeSynchronizer();
  sync.accept(frame, { playheadMs: 0, currentTrackId: undefined, totalDurationMs: 120_000 });
  const decision = sync.accept(
    { trackId: "186016", timelineMs: 42_600 },
    { playheadMs: 42_450, currentTrackId: "186016", totalDurationMs: 120_000 }
  );
  assert.equal(decision.relocate, false);
  assert.equal(decision.reason, "continuous");
});

test("a preloaded next track becomes current immediately", () => {
  const sync = new TapeSynchronizer();
  sync.accept(frame, { playheadMs: 0, currentTrackId: undefined, totalDurationMs: 120_000 });
  const decision = sync.accept(
    { trackId: "5257138", timelineMs: 60_000 },
    {
      playheadMs: 59_900,
      currentTrackId: "186016",
      expectedNextTrackId: "5257138",
      totalDurationMs: 120_000
    }
  );
  assert.equal(decision.relocate, true);
  assert.equal(decision.reason, "transition");
});

test("rewind and song changes still require two matching frames", () => {
  const sync = new TapeSynchronizer();
  sync.accept(frame, { playheadMs: 0, currentTrackId: undefined, totalDurationMs: 120_000 });
  const first = sync.accept(
    { trackId: "5257138", timelineMs: 80_000 },
    { playheadMs: 43_000, currentTrackId: "186016", totalDurationMs: 120_000 }
  );
  const second = sync.accept(
    { trackId: "5257138", timelineMs: 80_520 },
    { playheadMs: 43_520, currentTrackId: "186016", totalDurationMs: 120_000 }
  );
  assert.equal(first.relocate, false);
  assert.equal(first.reason, "confirming");
  assert.equal(second.relocate, true);
  assert.equal(second.reason, "resynchronize");
});

test("after tape stop, the next frame is an immediate acquisition again", () => {
  const sync = new TapeSynchronizer();
  sync.accept(frame, { playheadMs: 0, currentTrackId: undefined, totalDurationMs: 120_000 });
  sync.reset();
  const resumed = sync.accept(
    { trackId: "5257138", timelineMs: 75_000 },
    { playheadMs: 42_000, currentTrackId: "186016", totalDurationMs: 120_000 }
  );
  assert.equal(resumed.relocate, true);
  assert.equal(resumed.targetMs, 75_000);
  assert.equal(resumed.reason, "acquisition");
});
