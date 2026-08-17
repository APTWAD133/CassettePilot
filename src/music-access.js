export function uniqueStreamingTracks(clips = []) {
  const tracks = new Map();
  for (const clip of clips) {
    const id = String(clip?.neteaseId || "");
    if (!id || clip?.audioUrl || tracks.has(id)) continue;
    tracks.set(id, {
      id,
      title: String(clip?.title || `NetEase track ${id}`),
      artist: String(clip?.artist || "")
    });
  }
  return [...tracks.values()];
}

export async function preflightTrackAccess(tracks, resolveTrack, {
  concurrency = 3,
  onProgress = () => {}
} = {}) {
  const queue = [...tracks];
  const results = [];
  let completed = 0;
  const worker = async () => {
    while (queue.length) {
      const track = queue.shift();
      let access;
      try {
        access = await resolveTrack(track);
      } catch (error) {
        access = { available: false, message: error?.message || "Access check failed" };
      }
      results.push({ ...track, ...access });
      completed += 1;
      onProgress({ completed, total: tracks.length, track, access });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, tracks.length)) },
    worker
  ));
  const ordered = tracks.map((track) => results.find((result) => result.id === track.id));
  return {
    tracks: ordered,
    unavailable: ordered.filter((track) => !track.available),
    downgraded: ordered.filter((track) => track.available && track.resolution?.fallback)
  };
}

export async function preloadAudioEntries(clips, engines, {
  concurrency = 3,
  onProgress = () => {}
} = {}) {
  const tasks = engines.flatMap((engine) => clips.map((clip) => ({ engine, clip })));
  const queue = [...tasks];
  let completed = 0;
  let firstError = null;
  const worker = async () => {
    while (queue.length && !firstError) {
      const task = queue.shift();
      try {
        const entry = await task.engine.load(task.clip);
        if (!entry?.audio) throw entry?.error || new Error(`${task.clip.title || "Track"} could not be preloaded`);
        completed += 1;
        onProgress({ completed, total: tasks.length, clip: task.clip });
      } catch (error) {
        firstError ||= error;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, tasks.length)) },
    worker
  ));
  if (firstError) throw firstError;
  return { completed, total: tasks.length };
}
