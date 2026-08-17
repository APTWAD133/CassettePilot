class CassetteInputCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.blockSize = options.processorOptions?.blockSize || 2_048;
    this.left = new Float32Array(this.blockSize);
    this.right = new Float32Array(this.blockSize);
    this.offset = 0;
    this.hasRight = false;
  }

  flush() {
    const message = {
      left: this.left.buffer,
      right: this.hasRight ? this.right.buffer : null
    };
    const transfers = this.hasRight
      ? [message.left, message.right]
      : [message.left];
    this.port.postMessage(message, transfers);
    this.left = new Float32Array(this.blockSize);
    this.right = new Float32Array(this.blockSize);
    this.offset = 0;
    this.hasRight = false;
  }

  process(inputs) {
    const input = inputs[0];
    const leftInput = input?.[0];
    const rightInput = input?.[1];
    if (!leftInput) return true;

    let readAt = 0;
    while (readAt < leftInput.length) {
      const count = Math.min(leftInput.length - readAt, this.blockSize - this.offset);
      this.left.set(leftInput.subarray(readAt, readAt + count), this.offset);
      if (rightInput) {
        this.right.set(rightInput.subarray(readAt, readAt + count), this.offset);
        this.hasRight = true;
      }
      this.offset += count;
      readAt += count;
      if (this.offset === this.blockSize) this.flush();
    }
    return true;
  }
}

registerProcessor("cassette-input-capture", CassetteInputCapture);
