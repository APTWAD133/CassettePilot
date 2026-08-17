import test from "node:test";
import assert from "node:assert/strict";
import { preloadAudioEntries, preflightTrackAccess, uniqueStreamingTracks } from "../src/music-access.js";

test("music dubbing preflight checks each unique streaming track once", async () => {
  const tracks = uniqueStreamingTracks([
    { neteaseId: "1", title: "One", artist: "A" },
    { neteaseId: "1", title: "One duplicate", artist: "A" },
    { neteaseId: "2", title: "Local", audioUrl: "file:///local.wav" },
    { neteaseId: "3", title: "Three", artist: "C" }
  ]);
  assert.deepEqual(tracks.map((track) => track.id), ["1", "3"]);
  const calls = [];
  const summary = await preflightTrackAccess(tracks, async (track) => {
    calls.push(track.id);
    return track.id === "1"
      ? { available: true, resolution: { actual: "lossless", fallback: true } }
      : { available: false, message: "Subscription required" };
  });
  assert.deepEqual(calls.sort(), ["1", "3"]);
  assert.deepEqual(summary.downgraded.map((track) => track.id), ["1"]);
  assert.deepEqual(summary.unavailable.map((track) => track.id), ["3"]);
});

test("music preload prepares every clip for every active output engine", async () => {
  const calls = [];
  const engines = ["deck", "monitor"].map((name) => ({
    async load(clip) {
      calls.push(`${name}:${clip.id}`);
      return { audio: {} };
    }
  }));
  const progress = [];
  const result = await preloadAudioEntries(
    [{ id: "one", title: "One" }, { id: "two", title: "Two" }],
    engines,
    { concurrency: 2, onProgress: ({ completed }) => progress.push(completed) }
  );
  assert.deepEqual(calls.sort(), ["deck:one", "deck:two", "monitor:one", "monitor:two"]);
  assert.equal(result.completed, 4);
  assert.equal(progress.at(-1), 4);
});

test("music preload surfaces a failed media entry", async () => {
  const failure = new Error("Unavailable");
  await assert.rejects(
    preloadAudioEntries([{ id: "one", title: "One" }], [{ async load() { return { audio: null, error: failure }; } }]),
    failure
  );
});
