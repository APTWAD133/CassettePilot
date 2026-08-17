import { SIGNAL } from "./signal.js";
import { analyzeInputSignal, findFrameInSamples } from "./decoder.js";

export class InputDecoderPipeline {
  constructor() {
    this.reset();
  }

  reset() {
    this.sampleBuffer = { left: [], right: [] };
  }

  retainTail(sampleCount) {
    this.sampleBuffer.left = this.sampleBuffer.left.slice(-sampleCount);
    this.sampleBuffer.right = this.sampleBuffer.right.slice(-sampleCount);
  }

  push(left, right = null, sampleRate = SIGNAL.sampleRate) {
    const metrics = analyzeInputSignal(left, right, sampleRate);
    const symbolSizeHint = metrics.pilotDetected
      ? SIGNAL.samplesPerSymbol * SIGNAL.pilotTone / metrics.pilotHz
      : null;
    return { metrics, frame: this.decode(left, right, symbolSizeHint) };
  }

  decode(left, right = null, symbolSizeHint = null) {
    this.sampleBuffer.left.push(...left);
    if (right) this.sampleBuffer.right.push(...right);

    const maxSamples = SIGNAL.frameSymbols * 45 * 3;
    if (this.sampleBuffer.left.length > maxSamples) this.retainTail(maxSamples);

    const minimumSearchSamples = SIGNAL.frameSymbols * 34 * 2;
    if (this.sampleBuffer.left.length < minimumSearchSamples) {
      return null;
    }

    const input = this.sampleBuffer.right.length === this.sampleBuffer.left.length
      ? {
          left: Float32Array.from(this.sampleBuffer.left),
          right: Float32Array.from(this.sampleBuffer.right)
        }
      : Float32Array.from(this.sampleBuffer.left);
    const result = findFrameInSamples(input, { symbolSizeHint });
    if (result) {
      this.sampleBuffer.left = this.sampleBuffer.left.slice(result.end);
      this.sampleBuffer.right = this.sampleBuffer.right.slice(result.end);
      return result.frame;
    }

    this.retainTail(SIGNAL.frameSymbols * 45);
    return null;
  }
}
