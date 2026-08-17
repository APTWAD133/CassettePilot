export class TapeSynchronizer {
  constructor({ driftThresholdMs = 5_000, confirmations = 2 } = {}) {
    this.driftThresholdMs = driftThresholdMs;
    this.confirmations = confirmations;
    this.reset();
  }

  reset() {
    this.acquired = false;
    this.pending = null;
  }

  accept(frame, { playheadMs, currentTrackId, expectedNextTrackId, totalDurationMs = Number.MAX_SAFE_INTEGER }) {
    const targetMs = Math.max(0, Math.min(frame.timelineMs, totalDurationMs));
    if (!this.acquired) {
      this.acquired = true;
      this.pending = null;
      return { relocate: true, targetMs, acquired: true, reason: "acquisition" };
    }

    if (currentTrackId !== frame.trackId && expectedNextTrackId === frame.trackId) {
      this.pending = null;
      return { relocate: true, targetMs, acquired: true, reason: "transition" };
    }

    const drift = frame.timelineMs - playheadMs;
    const trackMismatch = currentTrackId !== frame.trackId;
    const largeJump = Math.abs(drift) > this.driftThresholdMs;
    if (!trackMismatch && !largeJump) {
      this.pending = null;
      return { relocate: false, targetMs, acquired: true, reason: "continuous" };
    }

    const signature = `${frame.trackId}:${Math.round(frame.timelineMs / 1000)}`;
    if (this.pending?.signature === signature || this.pending?.trackId === frame.trackId) {
      this.pending.count += 1;
    } else {
      this.pending = { signature, trackId: frame.trackId, count: 1 };
    }
    if (this.pending.count < this.confirmations) {
      return { relocate: false, targetMs, acquired: true, reason: "confirming" };
    }

    this.pending = null;
    return { relocate: true, targetMs, acquired: true, reason: "resynchronize" };
  }
}
