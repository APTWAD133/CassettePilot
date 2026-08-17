using System.Diagnostics;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace CassettePilot.AudioHost;

internal static class DeviceCatalog
{
    internal static IReadOnlyList<AudioDeviceInfo> Inputs() => Enumerate(DataFlow.Capture);
    internal static IReadOnlyList<AudioDeviceInfo> Outputs() => Enumerate(DataFlow.Render);

    internal static MMDevice Resolve(DataFlow flow, string? id)
    {
        using var enumerator = new MMDeviceEnumerator();
        if (!string.IsNullOrWhiteSpace(id)) return enumerator.GetDevice(id);
        return enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
    }

    private static IReadOnlyList<AudioDeviceInfo> Enumerate(DataFlow flow)
    {
        using var enumerator = new MMDeviceEnumerator();
        string? defaultId = null;
        try { defaultId = enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia).ID; }
        catch { /* Windows can have no active endpoint for a direction. */ }
        return enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active)
            .Select(device => new AudioDeviceInfo(device.ID, device.FriendlyName, device.ID == defaultId))
            .ToArray();
    }
}

internal sealed class AudioCaptureEngine : IDisposable
{
    private readonly Action<string, object?> _emit;
    private readonly NativePlayerEngine _player;
    private readonly SignalDecoder _decoder = new();
    private Channel<StereoBlock> _blocks = CreateBlockChannel();
    private CancellationTokenSource? _cancellation;
    private Task? _worker;
    private WasapiCapture? _capture;
    private StreamingStereoResampler? _resampler;
    private CarrierGate _carrierGate = new();
    private double _noiseGateDb = -46;
    private long _lastFrameAt;
    private long _lastMetricsEmitAt;
    private long _lastPipelineEmitAt;
    private long _captureSequence;
    private long _droppedBlocks;
    private long _decodedFrames;
    private long _processedBlocks;
    private long _discontinuities;

    internal AudioCaptureEngine(Action<string, object?> emit, NativePlayerEngine player)
    {
        _emit = emit;
        _player = player;
    }

    internal void SetNoiseGate(double value) => _noiseGateDb = Math.Clamp(value, -90, -20);

    internal void Start(string? deviceId)
    {
        Stop();
        _blocks = CreateBlockChannel();
        var device = DeviceCatalog.Resolve(DataFlow.Capture, deviceId);
        _capture = new WasapiCapture(device, true, 20);
        _resampler = new StreamingStereoResampler(_capture.WaveFormat.SampleRate, SignalProtocol.SampleRate);
        _capture.DataAvailable += OnDataAvailable;
        _capture.RecordingStopped += OnRecordingStopped;
        _cancellation = new CancellationTokenSource();
        _worker = Task.Run(() => DecodeLoop(_cancellation.Token));
        _capture.StartRecording();
        _emit("inputStarted", new
        {
            deviceId = device.ID,
            label = device.FriendlyName,
            sampleRate = _capture.WaveFormat.SampleRate,
            channels = _capture.WaveFormat.Channels,
            bitsPerSample = _capture.WaveFormat.BitsPerSample,
            encoding = _capture.WaveFormat.Encoding.ToString(),
            resampling = !_resampler.IsPassthrough
        });
    }

    internal void Stop()
    {
        if (_capture is not null)
        {
            _capture.DataAvailable -= OnDataAvailable;
            _capture.RecordingStopped -= OnRecordingStopped;
            try { _capture.StopRecording(); } catch { }
            _capture.Dispose();
            _capture = null;
        }
        var cancellation = _cancellation;
        var worker = _worker;
        _blocks.Writer.TryComplete();
        cancellation?.Cancel();
        try { worker?.Wait(1_000); } catch { }
        cancellation?.Dispose();
        _cancellation = null;
        _worker = null;
        _decoder.Reset();
        _resampler = null;
        _lastFrameAt = 0;
        _lastMetricsEmitAt = 0;
        _lastPipelineEmitAt = 0;
        _captureSequence = 0;
        _droppedBlocks = 0;
        _decodedFrames = 0;
        _processedBlocks = 0;
        _discontinuities = 0;
        _carrierGate = new CarrierGate();
        _player.SetCarrier(false);
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs eventArgs)
    {
        if (_capture is null || _resampler is null || eventArgs.BytesRecorded <= 0) return;
        var capturedAt = Stopwatch.GetTimestamp();
        try
        {
            var converted = SampleConverter.Convert(eventArgs.Buffer.AsSpan(0, eventArgs.BytesRecorded), _capture.WaveFormat);
            var resampled = _resampler.Push(converted.Left, converted.Right);
            if (resampled.Left.Length == 0) return;
            var sequence = Interlocked.Increment(ref _captureSequence);
            if (!_blocks.Writer.TryWrite(resampled with { CapturedAt = capturedAt, Sequence = sequence }))
                Interlocked.Increment(ref _droppedBlocks);
        }
        catch (Exception error)
        {
            _emit("error", new { scope = "capture", message = error.Message });
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs eventArgs)
    {
        if (eventArgs.Exception is not null) _emit("error", new { scope = "capture", message = eventArgs.Exception.Message });
    }

    private async Task DecodeLoop(CancellationToken cancellationToken)
    {
        Thread.CurrentThread.Priority = ThreadPriority.Normal;
        var expectedSequence = 0L;
        var maximumProcessingMs = 0d;
        try
        {
            await foreach (var block in _blocks.Reader.ReadAllAsync(cancellationToken))
            {
                var now = Stopwatch.GetTimestamp();
                if (expectedSequence != 0 && block.Sequence != expectedSequence)
                {
                    Interlocked.Increment(ref _discontinuities);
                    _decoder.Reset();
                    _carrierGate = new CarrierGate();
                    _lastFrameAt = 0;
                    _player.SetCarrier(false);
                    _emit("carrier", new
                    {
                        live = false,
                        pilotDetected = false,
                        validFrame = false,
                        reason = "input-discontinuity",
                        missingBlocks = Math.Max(1, block.Sequence - expectedSequence)
                    });
                }
                expectedSequence = block.Sequence + 1;
                var processingStartedAt = Stopwatch.GetTimestamp();
                var metrics = SignalDecoder.Analyze(block.Left, block.Right, SignalProtocol.SampleRate, _noiseGateDb);
                if (_lastMetricsEmitAt == 0 || ElapsedMilliseconds(_lastMetricsEmitAt, now) >= 100)
                {
                    _lastMetricsEmitAt = now;
                    _emit("metrics", metrics);
                }
                var symbolSizeHint = metrics.PilotDetected
                    ? SignalProtocol.SamplesPerSymbol * 6_000d / metrics.PilotHz
                    : (double?)null;
                var frame = _decoder.Push(block.Left, block.Right, symbolSizeHint, metrics.PilotChannel);
                var decodedThisBlock = false;
                TapeFrame? playbackFrame = null;
                while (frame is not null)
                {
                    decodedThisBlock = true;
                    _lastFrameAt = block.CapturedAt;
                    Interlocked.Increment(ref _decodedFrames);
                    _emit("frame", frame);
                    playbackFrame = frame;
                    frame = _decoder.Push([], [], symbolSizeHint, metrics.PilotChannel);
                }
                var frameFresh = _lastFrameAt > 0 && ElapsedMilliseconds(_lastFrameAt, now) < SignalProtocol.FrameSamples * 3_000d / SignalProtocol.SampleRate;
                var gate = _carrierGate.Update(metrics.PilotDetected, decodedThisBlock, block.CapturedAt, now);
                if (gate.Changed)
                {
                    _player.SetCarrier(gate.Live);
                    _emit("carrier", new { live = gate.Live, pilotDetected = metrics.PilotDetected, validFrame = frameFresh });
                }
                // Publish carrier acquisition before its decoded frame. The
                // player worker then applies the new seek while the old output
                // remains stopped, and only that frame can reopen playback.
                if (playbackFrame is not null) _player.PostFrame(playbackFrame);
                Interlocked.Increment(ref _processedBlocks);
                var processingMs = ElapsedMilliseconds(processingStartedAt, Stopwatch.GetTimestamp());
                maximumProcessingMs = Math.Max(maximumProcessingMs, processingMs);
                if (_lastPipelineEmitAt == 0 || ElapsedMilliseconds(_lastPipelineEmitAt, now) >= 1_000)
                {
                    _lastPipelineEmitAt = now;
                    var capturedBlocks = Interlocked.Read(ref _captureSequence);
                    var processedBlocks = Interlocked.Read(ref _processedBlocks);
                    var droppedBlocks = Interlocked.Read(ref _droppedBlocks);
                    _emit("pipeline", new
                    {
                        queueDelayMs = Math.Max(0, ElapsedMilliseconds(block.CapturedAt, now)),
                        processingMs,
                        maximumProcessingMs,
                        capturedBlocks,
                        processedBlocks,
                        droppedBlocks,
                        pendingBlocks = Math.Max(0, capturedBlocks - processedBlocks - droppedBlocks),
                        discontinuities = Interlocked.Read(ref _discontinuities),
                        decodedFrames = Interlocked.Read(ref _decodedFrames)
                    });
                    maximumProcessingMs = 0;
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            _emit("error", new { scope = "decoder", message = error.Message });
        }
    }

    private static double ElapsedMilliseconds(long from, long to) => (to - from) * 1_000d / Stopwatch.Frequency;

    public void Dispose() => Stop();

    internal static void AssertCarrierGateBehavior()
    {
        var gate = new CarrierGate();
        var origin = Stopwatch.GetTimestamp();
        long At(double milliseconds) => origin + (long)(milliseconds * Stopwatch.Frequency / 1_000d);
        if (!gate.Update(true, true, At(0), At(0)).Live)
            throw new InvalidOperationException("A fresh pilot and CRC frame did not acquire the carrier.");
        if (!gate.Update(true, false, At(1_100), At(1_100)).Live)
            throw new InvalidOperationException("A missed frame stopped playback inside the two-frame grace period.");
        if (gate.Update(true, false, At(1_300), At(1_300)).Live)
            throw new InvalidOperationException("Pilot-only audio kept the carrier alive beyond the two-frame grace period.");
        if (gate.Update(true, false, At(1_400), At(1_400)).Live)
            throw new InvalidOperationException("Pilot-only audio reacquired the carrier without a new frame.");
        if (!gate.Update(true, true, At(1_500), At(1_500)).Live)
            throw new InvalidOperationException("A new CRC frame did not reacquire the carrier.");
        if (gate.Update(false, false, At(1_801), At(1_801)).Live)
            throw new InvalidOperationException("Carrier did not release after pilot loss.");
    }

    private static Channel<StereoBlock> CreateBlockChannel() => Channel.CreateBounded<StereoBlock>(new BoundedChannelOptions(48)
    {
        // TryWrite must report saturation so the next accepted block carries a
        // visible sequence gap. The decoder then resets instead of joining two
        // non-contiguous pieces of PCM and searching a permanently corrupt tail.
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = false
    });

    private sealed class CarrierGate
    {
        private const double StopMs = 280;
        private const double FrameReleaseMs = 750 + SignalProtocol.FrameSamples * 2_000d / SignalProtocol.SampleRate;
        private bool _live;
        private long _lastPilotAt;
        private long _lastFrameAt;

        internal GateResult Update(bool pilotDetected, bool validFrame, long capturedAt, long now)
        {
            if (pilotDetected) _lastPilotAt = capturedAt;
            var freshValidFrame = validFrame && ElapsedMilliseconds(capturedAt, now) < FrameReleaseMs;
            if (freshValidFrame) _lastFrameAt = Math.Max(_lastFrameAt, capturedAt);
            if (!_live && pilotDetected && freshValidFrame)
            {
                _live = true;
                return new GateResult(true, true);
            }
            var pilotExpired = _lastPilotAt == 0 || ElapsedMilliseconds(_lastPilotAt, now) >= StopMs;
            var frameExpired = _lastFrameAt == 0 || ElapsedMilliseconds(_lastFrameAt, now) >= FrameReleaseMs;
            if (_live && (pilotExpired || frameExpired))
            {
                _live = false;
                _lastFrameAt = 0;
                return new GateResult(false, true);
            }
            return new GateResult(_live, false);
        }
    }

    private sealed record GateResult(bool Live, bool Changed);

}

internal sealed record StereoBlock(
    float[] Left,
    float[] Right,
    long CapturedAt = 0,
    long Sequence = 0);

internal sealed class StreamingStereoResampler
{
    private readonly double _step;
    private double _position;
    private float _previousLeft;
    private float _previousRight;
    private bool _hasPrevious;

    internal StreamingStereoResampler(int sourceRate, int targetRate)
    {
        if (sourceRate <= 0 || targetRate <= 0) throw new ArgumentOutOfRangeException(nameof(sourceRate));
        _step = sourceRate / (double)targetRate;
        IsPassthrough = sourceRate == targetRate;
    }

    internal bool IsPassthrough { get; }

    internal StereoBlock Push(float[] left, float[] right)
    {
        if (left.Length == 0) return new StereoBlock([], []);
        var effectiveRight = right.Length == left.Length ? right : left;
        if (IsPassthrough) return new StereoBlock(left, effectiveRight);

        var estimated = Math.Max(1, (int)Math.Ceiling((left.Length + 1) / _step));
        var outputLeft = new float[estimated];
        var outputRight = new float[estimated];
        var written = 0;
        if (!_hasPrevious) _position = 0;

        while (true)
        {
            var index = (int)Math.Floor(_position);
            float leftA;
            float leftB;
            float rightA;
            float rightB;
            if (index < 0)
            {
                if (!_hasPrevious) break;
                leftA = _previousLeft;
                rightA = _previousRight;
                leftB = left[0];
                rightB = effectiveRight[0];
            }
            else
            {
                if (index + 1 >= left.Length) break;
                leftA = left[index];
                rightA = effectiveRight[index];
                leftB = left[index + 1];
                rightB = effectiveRight[index + 1];
            }
            if (written == outputLeft.Length)
            {
                Array.Resize(ref outputLeft, outputLeft.Length * 2);
                Array.Resize(ref outputRight, outputRight.Length * 2);
            }
            var fraction = (float)(_position - index);
            outputLeft[written] = leftA + (leftB - leftA) * fraction;
            outputRight[written] = rightA + (rightB - rightA) * fraction;
            written += 1;
            _position += _step;
        }

        _position -= left.Length;
        _previousLeft = left[^1];
        _previousRight = effectiveRight[^1];
        _hasPrevious = true;
        if (written != outputLeft.Length)
        {
            Array.Resize(ref outputLeft, written);
            Array.Resize(ref outputRight, written);
        }
        return new StereoBlock(outputLeft, outputRight);
    }

    internal StereoBlock Flush()
    {
        if (IsPassthrough || !_hasPrevious || _position >= 0) return new StereoBlock([], []);
        var count = (int)Math.Ceiling(-_position / _step);
        if (count <= 0) return new StereoBlock([], []);
        var left = Enumerable.Repeat(_previousLeft, count).ToArray();
        var right = Enumerable.Repeat(_previousRight, count).ToArray();
        _position += count * _step;
        return new StereoBlock(left, right);
    }

    internal static void AssertBehavior()
    {
        var passthroughLeft = new float[] { 0, 0.25f, -0.5f };
        var passthroughRight = new float[] { 0, -0.25f, 0.5f };
        var passthrough = new StreamingStereoResampler(48_000, 48_000)
            .Push(passthroughLeft, passthroughRight);
        if (!ReferenceEquals(passthrough.Left, passthroughLeft)
            || !ReferenceEquals(passthrough.Right, passthroughRight))
            throw new InvalidOperationException("A 48 kHz stream was copied instead of passed through.");

        const int sourceRate = 44_100;
        const int targetRate = 48_000;
        const double toneHz = 440;
        var input = Enumerable.Range(0, sourceRate)
            .Select(index => (float)Math.Sin(2 * Math.PI * toneHz * index / sourceRate))
            .ToArray();
        var converted = new List<float>(targetRate);
        var resampler = new StreamingStereoResampler(sourceRate, targetRate);
        var chunkSizes = new[] { 137, 503, 911, 257 };
        var offset = 0;
        var chunk = 0;
        while (offset < input.Length)
        {
            var count = Math.Min(chunkSizes[chunk++ % chunkSizes.Length], input.Length - offset);
            var samples = input.AsSpan(offset, count).ToArray();
            converted.AddRange(resampler.Push(samples, samples).Left);
            offset += count;
        }
        converted.AddRange(resampler.Flush().Left);
        if (Math.Abs(converted.Count - targetRate) > 2)
            throw new InvalidOperationException($"Resampler returned {converted.Count} samples; expected approximately {targetRate}.");
        var maximumError = converted
            .Select((sample, index) => Math.Abs(sample - Math.Sin(2 * Math.PI * toneHz * index / targetRate)))
            .Max();
        if (maximumError > 0.01)
            throw new InvalidOperationException($"Streaming resampler discontinuity detected ({maximumError:F6}).");
    }
}

internal static class SampleConverter
{
    private static readonly Guid IeeeFloatSubFormat = new("00000003-0000-0010-8000-00aa00389b71");

    internal static (float[] Left, float[] Right) Convert(ReadOnlySpan<byte> bytes, WaveFormat format)
    {
        var channels = Math.Max(1, format.Channels);
        var bytesPerSample = Math.Max(1, format.BitsPerSample / 8);
        var frameCount = bytes.Length / (bytesPerSample * channels);
        var left = new float[frameCount];
        var right = new float[frameCount];
        for (var frame = 0; frame < frameCount; frame++)
        {
            var offset = frame * bytesPerSample * channels;
            left[frame] = ReadSample(bytes.Slice(offset, bytesPerSample), format);
            right[frame] = channels > 1
                ? ReadSample(bytes.Slice(offset + bytesPerSample, bytesPerSample), format)
                : left[frame];
        }
        return (left, right);
    }

    private static float ReadSample(ReadOnlySpan<byte> bytes, WaveFormat format)
    {
        var isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat
            || format is WaveFormatExtensible extensible && extensible.SubFormat == IeeeFloatSubFormat;
        if (format.BitsPerSample == 32 && isFloat)
            return BitConverter.ToSingle(bytes);
        return format.BitsPerSample switch
        {
            16 => BitConverter.ToInt16(bytes) / 32768f,
            24 => (((bytes[2] << 24) | (bytes[1] << 16) | (bytes[0] << 8)) >> 8) / 8388608f,
            32 => BitConverter.ToInt32(bytes) / 2147483648f,
            _ => (bytes[0] - 128) / 128f
        };
    }
}
