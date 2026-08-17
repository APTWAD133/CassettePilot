function lyricEntries(raw, translation = false) {
  if (!raw) return [];
  const entries = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const stamp of stamps) {
      const timeMs = Math.round((Number(stamp[1]) * 60 + Number(stamp[2])) * 1000);
      entries.push({ timeMs, text, translation });
    }
  }
  return entries;
}

export function parseTimedLyrics(rawLyrics, rawTranslation = "") {
  const primary = lyricEntries(rawLyrics);
  const translated = lyricEntries(rawTranslation, true);
  const translations = new Map(translated.map((line) => [line.timeMs, line.text]));
  return primary
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((line) => ({ ...line, translation: translations.get(line.timeMs) || "" }));
}

export function currentLyricIndex(lines, sourceMs) {
  let current = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs > sourceMs) break;
    current = index;
  }
  return current;
}

export function centeredLyricScrollTop(lineTop, lineHeight, viewportHeight, scrollHeight) {
  const maximum = Math.max(0, Number(scrollHeight) - Number(viewportHeight));
  const target = Number(lineTop) + Number(lineHeight) / 2 - Number(viewportHeight) / 2;
  return Math.max(0, Math.min(maximum, target));
}

export function shouldRenderPlaybackTrack(currentTrackId, nextTrackId, { refresh = false } = {}) {
  return refresh || (currentTrackId || null) !== (nextTrackId || null);
}

export function clipPlaybackProgress(clip, sourceMs) {
  if (!clip) return 0;
  const duration = Math.max(1, clip.trimEndMs - clip.trimStartMs);
  return Math.max(0, Math.min(1, (sourceMs - clip.trimStartMs) / duration));
}

export function interpolateGainEnvelope(envelope, timelineMs) {
  const startMs = Number(envelope?.gainStartTimelineMs ?? envelope?.timelineMs ?? timelineMs) || 0;
  const targetMs = Number(envelope?.gainTargetTimelineMs ?? startMs) || startMs;
  const startDb = Number(envelope?.gainDb ?? -96);
  const targetDb = Number(envelope?.gainTargetDb ?? startDb);
  if (targetMs <= startMs) return targetDb;
  const ratio = Math.max(0, Math.min(1, (timelineMs - startMs) / (targetMs - startMs)));
  return startDb + (targetDb - startDb) * ratio;
}

export function dbToLinearGain(gainDb) {
  const value = Number(gainDb);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, 10 ** (value / 20));
}

export function advanceTapeClock(clock, now, playing = true) {
  if (!clock) return null;
  const currentTime = Number(now) || 0;
  const previousTime = Number.isFinite(clock.updatedAt) ? clock.updatedAt : currentTime;
  const delta = playing ? Math.max(0, currentTime - previousTime) : 0;
  clock.timelineMs += delta;
  clock.sourceMs += delta;
  clock.updatedAt = currentTime;
  return clock;
}

export function reconcileTapeDisplayClock(
  clock,
  frame,
  now,
  { playing = true, force = false, snapThresholdMs = 1_250 } = {}
) {
  const currentTime = Number(now) || 0;
  if (!clock || !clock.frame || clock.frame.trackId !== frame.trackId) {
    return {
      clock: {
        frame,
        timelineMs: frame.timelineMs,
        sourceMs: frame.sourceMs,
        updatedAt: currentTime
      },
      timelineDriftMs: 0,
      sourceDriftMs: 0,
      relocated: true
    };
  }

  advanceTapeClock(clock, currentTime, playing);
  const timelineDriftMs = frame.timelineMs - clock.timelineMs;
  const sourceDriftMs = frame.sourceMs - clock.sourceMs;
  const relocated = force
    || Math.abs(timelineDriftMs) > snapThresholdMs
    || Math.abs(sourceDriftMs) > snapThresholdMs;
  if (relocated) {
    return {
      clock: {
        frame,
        timelineMs: frame.timelineMs,
        sourceMs: frame.sourceMs,
        updatedAt: currentTime
      },
      timelineDriftMs,
      sourceDriftMs,
      relocated: true
    };
  }

  clock.frame = frame;
  clock.updatedAt = currentTime;
  return { clock, timelineDriftMs, sourceDriftMs, relocated: false };
}

export function setTapeMediaAudible(media, audible) {
  if (!media) return;
  media.loop = false;
  media.muted = !audible;
}

export function relocateTapeMedia(media, targetSeconds, { audible = false } = {}) {
  if (!media) return false;
  const target = Math.max(0, Number(targetSeconds) || 0);
  // Silence the old position before changing currentTime. Restore the desired
  // audible state synchronously so playback no longer depends on delivery of
  // the renderer's `seeked` event while the window is occluded.
  media.muted = true;
  media.loop = false;
  try {
    media.currentTime = target;
  } catch {
    // Metadata for a newly discovered remote stream may not be available yet.
    // Keep it muted and let the next decoded frame retry without blocking.
    return false;
  }
  media.muted = !audible;
  return true;
}

export function stopTapeMedia(media, { keepWarm = true } = {}) {
  if (!media) return;
  media.muted = true;
  media.loop = Boolean(keepWarm && !media.paused);
  if (!keepWarm) media.pause();
}

export function shouldSeekTapeMedia(
  currentSeconds,
  targetSeconds,
  { force = false, pending = false } = {}
) {
  if (pending) return false;
  const distance = Math.abs(Number(currentSeconds) - Number(targetSeconds));
  return distance > 0.05 && (force || distance > 1.25);
}

export async function primeTapeMedia(media) {
  if (!media) return false;
  media.muted = true;
  media.loop = true;
  media.playsInline = true;
  if (!media.paused) return true;
  try {
    await media.play();
    return true;
  } catch {
    return false;
  }
}
