import { FLAGS } from "./signal.js";

export const DEMO_LIBRARY = [];

let idSeed = 1;
let gainPointSeed = 1;
let projectSeed = 1;

function newClipId() {
  return `clip-${Date.now()}-${idSeed++}`;
}

function newGainPointId() {
  return `gain-${Date.now()}-${gainPointSeed++}`;
}

function newProjectId() {
  return `mixtape-${Date.now()}-${projectSeed++}`;
}

export function createClip(track) {
  const durationMs = Math.max(1_000, Number(track.durationMs) || 180_000);
  return {
    id: newClipId(),
    neteaseId: String(track.neteaseId || Date.now()),
    title: track.title || "Untitled track",
    artist: track.artist || "Unknown artist",
    album: track.album || "Unknown album",
    coverUrl: track.coverUrl || "",
    lyrics: track.lyrics || "",
    translatedLyrics: track.translatedLyrics || "",
    durationMs,
    trimStartMs: 0,
    trimEndMs: durationMs,
    gainDb: 0,
    gainPoints: [
      { id: newGainPointId(), timeMs: 0, gainDb: 0 },
      { id: newGainPointId(), timeMs: durationMs, gainDb: 0 }
    ],
    fadeInMs: 0,
    fadeOutMs: 0,
    audioUrl: track.audioUrl || "",
    lane: 0,
    startMs: 0,
    endMs: durationMs,
    nextClipId: null,
    nextTrackId: "0"
  };
}

export function createProject(name = "Untitled Mixtape") {
  const clips = [];
  const bufferClips = [];
  return {
    id: newProjectId(),
    name,
    timelineVersion: 3,
    activeSide: "A",
    tapeLengthMinutes: 60,
    snappingEnabled: true,
    sides: {
      A: { clips, totalDurationMs: 0 },
      B: { clips: [], totalDurationMs: 0 }
    },
    clips,
    bufferClips,
    editorTrackHeight: 174,
    totalDurationMs: 0,
    updatedAt: Date.now()
  };
}

function collectionTrackDurationMs(track) {
  return Math.max(1_000, Number(track?.durationMs) || 180_000);
}

export function collectionImportPlan(tracks, tapeLengthMinutes = 60) {
  const durations = (Array.isArray(tracks) ? tracks : []).map(collectionTrackDurationMs);
  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  const normalizedTapeLengthMinutes = Math.max(1, Number(tapeLengthMinutes) || 60);
  const sideCapacityMs = normalizedTapeLengthMinutes * 30_000;
  let cursorMs = 0;
  let cutTrackIndex = -1;

  durations.some((duration, index) => {
    if (cursorMs + duration > sideCapacityMs) {
      cutTrackIndex = index;
      return true;
    }
    cursorMs += duration;
    return false;
  });

  return {
    tapeLengthMinutes: normalizedTapeLengthMinutes,
    sideCapacityMs,
    totalDurationMs,
    sideADurationMs: cursorMs,
    sideBDurationMs: Math.max(0, totalDurationMs - cursorMs),
    overflowMs: Math.max(0, totalDurationMs - cursorMs - sideCapacityMs),
    cutTrackIndex,
    sideAGapMs: Math.max(0, sideCapacityMs - cursorMs)
  };
}

export function createCollectionMixtape(name, tracks, tapeLengthMinutes = 60) {
  const sourceTracks = Array.isArray(tracks) ? tracks : [];
  const plan = collectionImportPlan(sourceTracks, tapeLengthMinutes);
  const imported = createProject(name || "Imported Mixtape");
  imported.tapeLengthMinutes = plan.tapeLengthMinutes;
  const sideAClips = [];
  const sideBClips = [];
  let sideACursorMs = 0;
  let sideBCursorMs = 0;

  sourceTracks.forEach((track, index) => {
    const durationMs = collectionTrackDurationMs(track);
    const clip = createClip({ ...track, durationMs });
    if (plan.cutTrackIndex < 0 || index < plan.cutTrackIndex) {
      clip.startMs = sideACursorMs;
      sideAClips.push(clip);
      sideACursorMs += durationMs;
    } else {
      clip.startMs = sideBCursorMs;
      sideBClips.push(clip);
      sideBCursorMs += durationMs;
    }
  });

  imported.sides.A.clips = sideAClips;
  imported.sides.B.clips = sideBClips;
  imported.activeSide = "A";
  imported.clips = sideAClips;
  imported.totalDurationMs = 0;
  recomputeTimeline(imported);
  activateProjectSide(imported, "B");
  activateProjectSide(imported, "A");
  return imported;
}

export function normalizeMixtapeProject(project) {
  const activeSide = project?.activeSide === "B" ? "B" : "A";
  const legacyClips = Array.isArray(project?.clips) ? project.clips : [];
  const legacyBufferClips = Array.isArray(project?.bufferClips) ? project.bufferClips : [];
  if (!project.sides || typeof project.sides !== "object") {
    project.sides = {
      A: { clips: legacyClips, totalDurationMs: Number(project.totalDurationMs) || 0 },
      B: { clips: [], totalDurationMs: 0 }
    };
  }
  const savedSideBuffers = [
    ...(Array.isArray(project.sides.A?.bufferClips) ? project.sides.A.bufferClips : []),
    ...(Array.isArray(project.sides.B?.bufferClips) ? project.sides.B.bufferClips : []),
    ...legacyBufferClips
  ];
  const seenBufferClipIds = new Set();
  const sharedBufferClips = savedSideBuffers.filter((clip) => {
    if (!clip) return false;
    const key = clip.id || clip;
    if (seenBufferClipIds.has(key)) return false;
    seenBufferClipIds.add(key);
    return true;
  });
  for (const side of ["A", "B"]) {
    const value = project.sides[side];
    project.sides[side] = {
      clips: Array.isArray(value?.clips) ? value.clips : [],
      totalDurationMs: Math.max(0, Number(value?.totalDurationMs) || 0)
    };
  }
  if (Array.isArray(project.clips)) {
    project.sides[activeSide].clips = project.clips;
    project.sides[activeSide].totalDurationMs = Math.max(0, Number(project.totalDurationMs) || 0);
  }
  project.activeSide = activeSide;
  project.tapeLengthMinutes = Math.max(1, Number(project.tapeLengthMinutes) || 60);
  project.snappingEnabled = project.snappingEnabled !== false;
  project.editorTrackHeight = Math.max(150, Number(project.editorTrackHeight) || 174);
  project.clips = project.sides[activeSide].clips;
  project.bufferClips = sharedBufferClips;
  project.totalDurationMs = project.sides[activeSide].totalDurationMs;
  return project;
}

export function syncActiveSide(project) {
  normalizeMixtapeProject(project);
  const side = project.sides[project.activeSide];
  side.clips = project.clips;
  side.totalDurationMs = Math.max(0, Number(project.totalDurationMs) || 0);
  return project;
}

export function activateProjectSide(project, side) {
  syncActiveSide(project);
  project.activeSide = side === "B" ? "B" : "A";
  project.clips = project.sides[project.activeSide].clips;
  project.totalDurationMs = project.sides[project.activeSide].totalDurationMs;
  return recomputeTimeline(project);
}

export function cassetteSideCapacityMs(project) {
  return Math.max(30_000, Number(project?.tapeLengthMinutes || 60) * 30_000);
}

export function snapClipStart(rawStartMs, durationMs, edgeTargets = [], {
  thresholdMs = 500
} = {}) {
  const raw = Math.max(0, Number(rawStartMs) || 0);
  const duration = Math.max(1, Number(durationMs) || 1);
  let best = null;
  edgeTargets.forEach((value) => {
    const targetMs = Math.max(0, Number(value) || 0);
    const startDistance = Math.abs(raw - targetMs);
    if (startDistance <= thresholdMs && (!best || startDistance < best.distanceMs)) {
      best = { startMs: targetMs, guideMs: targetMs, distanceMs: startDistance };
    }
    const endDistance = Math.abs(raw + duration - targetMs);
    const endAlignedStartMs = targetMs - duration;
    if (endAlignedStartMs >= 0 && endDistance <= thresholdMs && (!best || endDistance < best.distanceMs)) {
      best = { startMs: targetMs - duration, guideMs: targetMs, distanceMs: endDistance };
    }
  });
  if (!best) return { startMs: Math.round(raw), guideMs: null, distanceMs: null, snapped: false };
  best.startMs = Math.max(0, Math.round(best.startMs));
  return { ...best, snapped: true };
}

export function clipDuration(clip) {
  return Math.max(1, clip.trimEndMs - clip.trimStartMs);
}

function gainFromPoints(points, timeMs, fallback = 0) {
  if (!points.length) return fallback;
  const time = Math.max(0, timeMs);
  if (time <= points[0].timeMs) return points[0].gainDb;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (time > right.timeMs) continue;
    const left = points[index - 1];
    const ratio = (time - left.timeMs) / Math.max(1, right.timeMs - left.timeMs);
    return left.gainDb + (right.gainDb - left.gainDb) * ratio;
  }
  return points.at(-1).gainDb;
}

export function normalizeGainPoints(clip) {
  const duration = clipDuration(clip);
  const fallback = Number(clip.gainDb) || 0;
  const source = Array.isArray(clip.gainPoints) ? clip.gainPoints : [];
  const points = source
    .map((point) => ({
      id: point.id || newGainPointId(),
      timeMs: Math.max(0, Math.min(duration, Number(point.timeMs) || 0)),
      gainDb: Math.max(-60, Math.min(12, Number(point.gainDb) || 0))
    }))
    .sort((a, b) => a.timeMs - b.timeMs);
  const deduped = points.filter((point, index) => index === points.length - 1 || point.timeMs !== points[index + 1].timeMs);
  if (!deduped.length) {
    deduped.push(
      { id: newGainPointId(), timeMs: 0, gainDb: fallback },
      { id: newGainPointId(), timeMs: duration, gainDb: fallback }
    );
  } else {
    if (deduped[0].timeMs > 0) {
      deduped.unshift({ id: newGainPointId(), timeMs: 0, gainDb: gainFromPoints(deduped, 0, fallback) });
    }
    if (deduped.at(-1).timeMs < duration) {
      deduped.push({ id: newGainPointId(), timeMs: duration, gainDb: gainFromPoints(deduped, duration, fallback) });
    }
  }
  clip.gainPoints = deduped;
  return clip.gainPoints;
}

export function gainAtLocalMs(clip, localMs) {
  return gainFromPoints(normalizeGainPoints(clip), localMs, Number(clip.gainDb) || 0);
}

export function addGainPoint(clip, timeMs, gainDb) {
  const point = {
    id: newGainPointId(),
    timeMs: Math.max(0, Math.min(clipDuration(clip), Number(timeMs) || 0)),
    gainDb: Math.max(-60, Math.min(12, Number(gainDb) || 0))
  };
  clip.gainPoints = normalizeGainPoints(clip).filter((item) => Math.abs(item.timeMs - point.timeMs) > 20);
  clip.gainPoints.push(point);
  normalizeGainPoints(clip);
  return point;
}

export function moveGainPoint(clip, pointId, timeMs, gainDb) {
  const points = normalizeGainPoints(clip);
  const point = points.find((item) => item.id === pointId);
  if (!point) return null;
  const duration = clipDuration(clip);
  const isStart = point.timeMs === 0;
  const isEnd = point.timeMs === duration;
  point.timeMs = isStart ? 0 : isEnd ? duration : Math.max(0, Math.min(duration, Number(timeMs) || 0));
  point.gainDb = Math.max(-60, Math.min(12, Number(gainDb) || 0));
  normalizeGainPoints(clip);
  return point;
}

export function removeGainPoint(clip, pointId) {
  const points = normalizeGainPoints(clip);
  if (points.length <= 2) return false;
  const point = points.find((item) => item.id === pointId);
  if (!point || point.timeMs === 0 || point.timeMs === clipDuration(clip)) return false;
  clip.gainPoints = points.filter((item) => item.id !== pointId);
  return true;
}

export function sliceGainPoints(clip, fromMs, toMs) {
  const from = Math.max(0, fromMs);
  const to = Math.max(from + 1, Math.min(clipDuration(clip), toMs));
  const points = normalizeGainPoints(clip);
  return [
    { id: newGainPointId(), timeMs: 0, gainDb: gainFromPoints(points, from, clip.gainDb) },
    ...points
      .filter((point) => point.timeMs > from && point.timeMs < to)
      .map((point) => ({ ...point, timeMs: point.timeMs - from })),
    { id: newGainPointId(), timeMs: to - from, gainDb: gainFromPoints(points, to, clip.gainDb) }
  ];
}

export function recomputeTimeline(project) {
  normalizeMixtapeProject(project);
  if (!project.id) project.id = newProjectId();
  if (project.timelineVersion !== 3) migrateSingleTrackTimeline(project);
  project.clips.forEach((clip) => {
    clip.startMs = Math.max(0, Number(clip.startMs) || 0);
    clip.lane = 0;
    clip.endMs = clip.startMs + clipDuration(clip);
    normalizeGainPoints(clip);
  });
  project.bufferClips.forEach((clip, index) => {
    const bufferXMs = Number(clip.bufferXMs);
    const bufferY = Number(clip.bufferY);
    clip.bufferXMs = Math.max(0, Number.isFinite(bufferXMs) ? bufferXMs : 0);
    clip.bufferY = Math.max(0, Number.isFinite(bufferY) ? bufferY : index * 18);
    clip.lane = 0;
    clip.endMs = clip.startMs + clipDuration(clip);
    clip.nextClipId = null;
    clip.nextTrackId = "0";
    normalizeGainPoints(clip);
  });
  project.totalDurationMs = project.clips.reduce((maximum, clip) => Math.max(maximum, clip.endMs), 0);
  updateNextClipIds(project);
  project.sides[project.activeSide].clips = project.clips;
  project.sides[project.activeSide].totalDurationMs = project.totalDurationMs;
  return project;
}

export function findProjectClip(project, clipId) {
  const timelineClip = project.clips.find((clip) => clip.id === clipId);
  if (timelineClip) return { clip: timelineClip, zone: "timeline" };
  const bufferClip = project.bufferClips.find((clip) => clip.id === clipId);
  return bufferClip ? { clip: bufferClip, zone: "buffer" } : null;
}

export function moveClipToBuffer(project, clipId, bufferXMs = 0, bufferY = 0) {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  const [clip] = project.clips.splice(index, 1);
  clip.bufferXMs = Math.max(0, Math.round(Number(bufferXMs) || 0));
  clip.bufferY = Math.max(0, Math.round(Number(bufferY) || 0));
  clip.nextClipId = null;
  clip.nextTrackId = "0";
  project.bufferClips.push(clip);
  recomputeTimeline(project);
  return clip;
}

export function moveClipToTimeline(project, clipId, startMs = 0) {
  const index = project.bufferClips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  const [clip] = project.bufferClips.splice(index, 1);
  clip.startMs = Math.max(0, Math.round(Number(startMs) || 0));
  delete clip.bufferXMs;
  delete clip.bufferY;
  project.clips.push(clip);
  recomputeTimeline(project);
  return clip;
}

export function removeProjectClips(project, clipIds) {
  const ids = new Set(clipIds || []);
  const timelineCount = project.clips.length;
  const bufferCount = project.bufferClips.length;
  project.clips = project.clips.filter((clip) => !ids.has(clip.id));
  project.bufferClips = project.bufferClips.filter((clip) => !ids.has(clip.id));
  recomputeTimeline(project);
  return timelineCount + bufferCount - project.clips.length - project.bufferClips.length;
}

function migrateSingleTrackTimeline(project) {
  const originalOrder = new Map(project.clips.map((clip, index) => [clip.id, index]));
  project.clips = [...project.clips].sort((a, b) =>
    (Number(a.startMs) || 0) - (Number(b.startMs) || 0) ||
    (Number(a.lane) || 0) - (Number(b.lane) || 0) ||
    originalOrder.get(a.id) - originalOrder.get(b.id)
  );
  let cursor = 0;
  project.clips.forEach((clip) => {
    clip.startMs = Math.max(cursor, Math.max(0, Number(clip.startMs) || 0));
    clip.lane = 0;
    clip.endMs = clip.startMs + clipDuration(clip);
    cursor = clip.endMs;
  });
  project.timelineVersion = 3;
}

export function timelineOrder(project) {
  const originalOrder = new Map(project.clips.map((clip, index) => [clip.id, index]));
  return [...project.clips].sort((a, b) =>
    a.startMs - b.startMs ||
    originalOrder.get(a.id) - originalOrder.get(b.id)
  );
}

export function updateNextClipIds(project) {
  const ordered = timelineOrder(project);
  ordered.forEach((clip, index) => {
    const next = ordered[index + 1] || null;
    clip.nextClipId = next?.id || null;
    clip.nextTrackId = next?.neteaseId || "0";
  });
  return project;
}

export function duplicateClip(clip, startMs = clip.startMs) {
  return {
    ...structuredClone(clip),
    id: newClipId(),
    startMs: Math.max(0, startMs),
    lane: 0,
    endMs: Math.max(0, startMs) + clipDuration(clip),
    nextClipId: null,
    nextTrackId: "0"
  };
}

export function overwriteLaneWithClip(project, incomingClipId, protectedClipIds = []) {
  const incoming = project.clips.find((clip) => clip.id === incomingClipId);
  if (!incoming) return { removed: 0, trimmed: 0, split: 0 };
  const protectedIds = new Set(protectedClipIds);

  const victims = project.clips.filter((clip) =>
    clip.id !== incoming.id &&
    !protectedIds.has(clip.id) &&
    clip.lane === incoming.lane &&
    Math.max(clip.startMs, incoming.startMs) < Math.min(clip.endMs, incoming.endMs)
  );
  const removeIds = new Set();
  const created = [];
  let trimmed = 0;
  let split = 0;

  for (const victim of victims) {
    const original = structuredClone(victim);
    if (incoming.startMs <= original.startMs && incoming.endMs >= original.endMs) {
      removeIds.add(victim.id);
      continue;
    }

    if (incoming.startMs <= original.startMs) {
      const removedDuration = incoming.endMs - original.startMs;
      victim.gainPoints = sliceGainPoints(original, removedDuration, clipDuration(original));
      victim.startMs = incoming.endMs;
      victim.trimStartMs = Math.min(
        victim.trimEndMs - 1,
        original.trimStartMs + removedDuration
      );
      victim.fadeInMs = 0;
      trimmed += 1;
      continue;
    }

    if (incoming.endMs >= original.endMs) {
      victim.gainPoints = sliceGainPoints(original, 0, incoming.startMs - original.startMs);
      victim.trimEndMs = original.trimStartMs + (incoming.startMs - original.startMs);
      victim.fadeOutMs = 0;
      trimmed += 1;
      continue;
    }

    const leftDuration = incoming.startMs - original.startMs;
    const rightOffset = incoming.endMs - original.startMs;
    victim.gainPoints = sliceGainPoints(original, 0, leftDuration);
    victim.trimEndMs = original.trimStartMs + leftDuration;
    victim.fadeOutMs = 0;
    const right = duplicateClip(original, incoming.endMs, original.lane);
    right.trimStartMs = original.trimStartMs + (incoming.endMs - original.startMs);
    right.trimEndMs = original.trimEndMs;
    right.gainPoints = sliceGainPoints(original, rightOffset, clipDuration(original));
    right.fadeInMs = 0;
    created.push(right);
    split += 1;
  }

  project.clips = project.clips.filter((clip) => !removeIds.has(clip.id) && clip.id !== incoming.id);
  project.clips.push(...created, incoming);
  recomputeTimeline(project);
  return { removed: removeIds.size, trimmed, split };
}

function fadeGainDb(clip, timelineMs) {
  const local = timelineMs - clip.startMs;
  const remaining = clip.endMs - timelineMs;
  let amplitude = 1;
  if (clip.fadeInMs > 0 && local < clip.fadeInMs) amplitude *= Math.max(0.001, local / clip.fadeInMs);
  if (clip.fadeOutMs > 0 && remaining < clip.fadeOutMs) amplitude *= Math.max(0.001, remaining / clip.fadeOutMs);
  return Math.max(-96, gainAtLocalMs(clip, local) + 20 * Math.log10(amplitude));
}

export function nextGainTarget(clip, timelineMs) {
  if (!clip) return { timelineMs: Math.max(0, timelineMs), gainDb: -96 };
  const duration = clipDuration(clip);
  const local = Math.max(0, Math.min(duration, timelineMs - clip.startMs));
  const breakpoints = normalizeGainPoints(clip).map((point) => point.timeMs);
  if (clip.fadeInMs > 0) breakpoints.push(Math.min(duration, clip.fadeInMs));
  if (clip.fadeOutMs > 0) breakpoints.push(Math.max(0, duration - clip.fadeOutMs));
  breakpoints.push(duration);
  const targetLocal = breakpoints
    .filter((timeMs) => timeMs > local + 0.5)
    .sort((a, b) => a - b)[0] ?? local;
  const targetTimelineMs = clip.startMs + targetLocal;
  return {
    timelineMs: Math.round(targetTimelineMs),
    gainDb: fadeGainDb(clip, targetTimelineMs)
  };
}

export function activeClipsAt(project, timelineMs) {
  const active = project.clips
    .filter((clip) => timelineMs >= clip.startMs && timelineMs < clip.endMs)
    .map((clip) => ({
      clip,
      sourceMs: Math.round(clip.trimStartMs + timelineMs - clip.startMs),
      gainDb: fadeGainDb(clip, timelineMs)
    }));
  active.sort((a, b) => a.clip.startMs - b.clip.startMs);
  return active.length ? [active.at(-1)] : [];
}

export function frameAt(project, timelineMs) {
  const time = Math.min(Math.max(0, timelineMs), project.totalDurationMs);
  const active = activeClipsAt(project, Math.max(0, Math.min(time, project.totalDurationMs - 1)));
  const ordered = timelineOrder(project);
  const preceding = [...ordered].reverse().find((clip) => clip.startMs <= time) || ordered[0];
  const current = active[0] || {
    clip: preceding,
    sourceMs: preceding ? Math.min(preceding.trimEndMs, preceding.trimStartMs + Math.max(0, time - preceding.startMs)) : 0,
    gainDb: -96
  };
  const linkedNext = current.clip?.nextClipId
    ? project.clips.find((clip) => clip.id === current.clip.nextClipId)
    : null;
  const next = linkedNext;

  let flags = FLAGS.playing;
  if (time >= project.totalDurationMs - 1) flags |= FLAGS.end;

  const gainTarget = nextGainTarget(current.clip, time);

  return {
    flags,
    timelineMs: Math.round(time),
    trackId: current.clip?.neteaseId || "0",
    sourceMs: Math.round(current.sourceMs || current.clip?.trimStartMs || 0),
    gainDb: Number(current.gainDb ?? -96),
    gainTargetTimelineMs: gainTarget.timelineMs,
    gainTargetDb: gainTarget.gainDb,
    nextTrackId: next?.neteaseId || "0"
  };
}

export function splitClip(project, clipId, timelineMs) {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  const clip = project.clips[index];
  if (timelineMs <= clip.startMs + 500 || timelineMs >= clip.endMs - 500) return null;
  const sourceSplit = clip.trimStartMs + timelineMs - clip.startMs;
  const localSplit = timelineMs - clip.startMs;
  const original = structuredClone(clip);
  const right = {
    ...clip,
    id: newClipId(),
    trimStartMs: sourceSplit,
    fadeInMs: 0,
    startMs: timelineMs,
    nextClipId: null,
    nextTrackId: "0"
  };
  clip.gainPoints = sliceGainPoints(original, 0, localSplit);
  right.gainPoints = sliceGainPoints(original, localSplit, clipDuration(original));
  clip.trimEndMs = sourceSplit;
  clip.fadeOutMs = 0;
  project.clips.splice(index + 1, 0, right);
  recomputeTimeline(project);
  return right;
}

export function formatTime(milliseconds, precise = false) {
  const safe = Math.max(0, Number(milliseconds) || 0);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const tenths = Math.floor((safe % 1_000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}${precise ? `.${tenths}` : ""}`;
}
