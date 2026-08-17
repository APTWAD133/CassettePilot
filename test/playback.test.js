import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTimedLyrics,
  currentLyricIndex,
  centeredLyricScrollTop,
  shouldRenderPlaybackTrack,
  clipPlaybackProgress,
  interpolateGainEnvelope,
  dbToLinearGain,
  advanceTapeClock,
  reconcileTapeDisplayClock,
  setTapeMediaAudible,
  relocateTapeMedia,
  stopTapeMedia,
  shouldSeekTapeMedia,
  primeTapeMedia
} from "../src/playback.js";

test("timed lyrics are ordered and paired with translations", () => {
  const lines = parseTimedLyrics(
    "[00:05.20]Second\n[00:01.00]First",
    "[00:01.00]第一句\n[00:05.20]第二句"
  );
  assert.deepEqual(lines, [
    { timeMs: 1_000, text: "First", translation: "第一句" },
    { timeMs: 5_200, text: "Second", translation: "第二句" }
  ]);
  assert.equal(currentLyricIndex(lines, 5_199), 0);
  assert.equal(currentLyricIndex(lines, 5_200), 1);
});

test("lyric centering is container-local and clamps at both ends", () => {
  assert.equal(centeredLyricScrollTop(600, 40, 400, 1_200), 420);
  assert.equal(centeredLyricScrollTop(50, 40, 400, 1_200), 0);
  assert.equal(centeredLyricScrollTop(1_100, 40, 400, 1_200), 800);
});

test("decoded frames do not rebuild lyrics for the same playback track", () => {
  assert.equal(shouldRenderPlaybackTrack("tape-186016", "tape-186016"), false);
  assert.equal(shouldRenderPlaybackTrack("tape-186016", "tape-186016", { refresh: true }), true);
  assert.equal(shouldRenderPlaybackTrack("tape-186016", "tape-347230"), true);
});

test("playback progress follows the trimmed source range and clamps", () => {
  const clip = { trimStartMs: 10_000, trimEndMs: 30_000 };
  assert.equal(clipPlaybackProgress(clip, 5_000), 0);
  assert.equal(clipPlaybackProgress(clip, 20_000), 0.5);
  assert.equal(clipPlaybackProgress(clip, 35_000), 1);
});

test("tape gain interpolates continuously toward the next encoded keypoint", () => {
  const envelope = {
    gainStartTimelineMs: 2_000,
    gainDb: -4,
    gainTargetTimelineMs: 4_000,
    gainTargetDb: -8
  };
  assert.equal(interpolateGainEnvelope(envelope, 1_000), -4);
  assert.equal(interpolateGainEnvelope(envelope, 3_000), -6);
  assert.equal(interpolateGainEnvelope(envelope, 5_000), -8);
});

test("positive decibel gain produces amplification above unity", () => {
  assert.equal(dbToLinearGain(0), 1);
  assert.ok(Math.abs(dbToLinearGain(6) - 1.9952623149688795) < 1e-12);
  assert.ok(dbToLinearGain(12) > 3.98);
  assert.equal(dbToLinearGain(-Infinity), 0);
});

test("tape clock advances across a throttled background-window gap", () => {
  const clock = { timelineMs: 20_000, sourceMs: 5_000, updatedAt: 1_000 };
  advanceTapeClock(clock, 6_000, true);
  assert.deepEqual(clock, {
    timelineMs: 25_000,
    sourceMs: 10_000,
    updatedAt: 6_000
  });
  advanceTapeClock(clock, 6_000, true);
  assert.equal(clock.timelineMs, 25_000);
  advanceTapeClock(clock, 8_000, false);
  assert.equal(clock.timelineMs, 25_000);
  assert.equal(clock.updatedAt, 8_000);
});

test("native display clock stays continuous across ordinary decoded frames", () => {
  const clock = {
    frame: { trackId: "186016" },
    timelineMs: 20_000,
    sourceMs: 5_000,
    updatedAt: 1_000
  };
  const result = reconcileTapeDisplayClock(clock, {
    trackId: "186016",
    timelineMs: 20_238,
    sourceMs: 5_238
  }, 1_300, { playing: true });
  assert.equal(result.relocated, false);
  assert.equal(result.timelineDriftMs, -62);
  assert.equal(result.clock.timelineMs, 20_300);
  assert.equal(result.clock.sourceMs, 5_300);
});

test("native display clock still snaps on a real tape relocation", () => {
  const clock = {
    frame: { trackId: "186016" },
    timelineMs: 20_000,
    sourceMs: 5_000,
    updatedAt: 1_000
  };
  const result = reconcileTapeDisplayClock(clock, {
    trackId: "186016",
    timelineMs: 50_000,
    sourceMs: 35_000
  }, 1_250, { playing: true });
  assert.equal(result.relocated, true);
  assert.equal(result.clock.timelineMs, 50_000);
  assert.equal(result.clock.sourceMs, 35_000);
});

test("cassette stop keeps authorized media warm for background restart", () => {
  const media = {
    muted: false,
    loop: false,
    paused: false,
    pause() { this.paused = true; }
  };
  stopTapeMedia(media, { keepWarm: true });
  assert.deepEqual({ muted: media.muted, loop: media.loop, paused: media.paused }, {
    muted: true,
    loop: true,
    paused: false
  });
  setTapeMediaAudible(media, true);
  assert.deepEqual({ muted: media.muted, loop: media.loop }, { muted: false, loop: false });
  stopTapeMedia(media, { keepWarm: false });
  assert.equal(media.paused, true);
});

test("rewind relocation does not restart a pending background media seek", () => {
  assert.equal(shouldSeekTapeMedia(80, 62, { force: true }), true);
  assert.equal(shouldSeekTapeMedia(80, 62, { force: true, pending: true }), false);
  assert.equal(shouldSeekTapeMedia(62, 62.02, { force: true }), false);
});

test("new tape media is primed muted before a background transition", async () => {
  let playCalls = 0;
  const media = {
    muted: false,
    loop: false,
    playsInline: false,
    paused: true,
    async play() {
      playCalls += 1;
      this.paused = false;
    }
  };
  assert.equal(await primeTapeMedia(media), true);
  assert.deepEqual({
    muted: media.muted,
    loop: media.loop,
    playsInline: media.playsInline,
    paused: media.paused,
    playCalls
  }, {
    muted: true,
    loop: true,
    playsInline: true,
    paused: false,
    playCalls: 1
  });
  assert.equal(await primeTapeMedia(media), true);
  assert.equal(playCalls, 1);
});

test("tape relocation becomes audible without waiting for a seeked event", () => {
  const operations = [];
  let muted = false;
  let currentTime = 8;
  const media = {
    loop: true,
    get muted() {
      return muted;
    },
    set muted(value) {
      muted = value;
      operations.push(["muted", value]);
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value) {
      currentTime = value;
      operations.push(["currentTime", value]);
    }
  };

  assert.equal(relocateTapeMedia(media, 42.25, { audible: true }), true);
  assert.deepEqual(operations, [
    ["muted", true],
    ["currentTime", 42.25],
    ["muted", false]
  ]);
  assert.equal(media.loop, false);
});

test("tape relocation defers safely when remote metadata is not ready", () => {
  let muted = false;
  const media = {
    loop: true,
    get muted() {
      return muted;
    },
    set muted(value) {
      muted = value;
    },
    set currentTime(_value) {
      throw new DOMException("Media metadata is unavailable", "InvalidStateError");
    }
  };

  assert.equal(relocateTapeMedia(media, 120, { audible: true }), false);
  assert.equal(media.muted, true);
  assert.equal(media.loop, false);
});
