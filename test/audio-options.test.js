import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_QUALITY_OPTIONS,
  audioQualityFallbackLevels,
  audioQualityFromPlaybackItem,
  legacyBitrateForQuality,
  normalizeAudioQuality,
  playbackQualityResolution,
  normalizeDubbingSource
} from "../src/audio-options.js";

test("NetEase quality levels are normalized before API requests", () => {
  assert.deepEqual(AUDIO_QUALITY_OPTIONS.map((option) => option.value), [
    "best", "standard", "higher", "exhigh", "lossless", "hires",
    "jyeffect", "sky", "dolby", "jymaster"
  ]);
  assert.equal(normalizeAudioQuality("HIRES"), "hires");
  assert.equal(normalizeAudioQuality("unsupported"), "best");
});

test("quality fallback stays within the selected tier and authorized lower tiers", () => {
  assert.deepEqual(audioQualityFallbackLevels("best"), [
    "jymaster", "hires", "lossless", "exhigh", "higher", "standard"
  ]);
  assert.deepEqual(audioQualityFallbackLevels("lossless"), ["lossless", "exhigh", "higher", "standard"]);
  assert.deepEqual(audioQualityFallbackLevels("dolby"), ["dolby", "hires", "lossless", "exhigh", "higher", "standard"]);
});

test("the granted playback quality is derived from provider metadata", () => {
  assert.equal(audioQualityFromPlaybackItem({ level: "lossless", br: 999_000 }, "jymaster"), "lossless");
  assert.equal(audioQualityFromPlaybackItem({ br: 320_000 }, "jymaster"), "exhigh");
  assert.deepEqual(playbackQualityResolution("jymaster", "lossless", { level: "lossless", br: 999_000 }), {
    requested: "jymaster",
    attempted: "lossless",
    actual: "lossless",
    fallback: true,
    bitrate: 999_000
  });
});

test("legacy playback uses the nearest available bitrate", () => {
  assert.equal(legacyBitrateForQuality("standard"), 128_000);
  assert.equal(legacyBitrateForQuality("higher"), 192_000);
  assert.equal(legacyBitrateForQuality("lossless"), 320_000);
});

test("dubbing source defaults safely to the control signal", () => {
  assert.equal(normalizeDubbingSource("music"), "music");
  assert.equal(normalizeDubbingSource("control"), "control");
  assert.equal(normalizeDubbingSource("unknown"), "control");
});
