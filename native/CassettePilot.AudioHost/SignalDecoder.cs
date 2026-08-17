using System.Buffers.Binary;

namespace CassettePilot.AudioHost;

internal static class SignalProtocol
{
    internal const int Version = 2;
    internal const int SampleRate = 48_000;
    internal const int SamplesPerSymbol = 40;
    internal const int PreambleSymbols = 12;
    internal const int SyncSymbols = 8;
    internal const int PayloadBytes = 38;
    internal const int FrameSymbols = PreambleSymbols + SyncSymbols + PayloadBytes * 7;
    internal const int FrameSamples = FrameSymbols * SamplesPerSymbol;
    internal const int SyncWord = 0xddaa;
    internal static readonly double[] Tones = [1_200, 2_400, 3_600, 4_800];
    internal static readonly double[] SymbolSizes = [40, 39, 41, 38, 42, 37, 43, 36, 44, 35, 45, 34];
    internal static readonly int[] HeaderSymbols = [0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 2, 1, 2, 1, 3, 3, 3, 3];
}

internal sealed class SignalDecoder
{
    private const int LockedSearchMargin = 192;
    private readonly StereoSampleBuffer _samples = new();
    private bool _locked;
    private double _lockedSymbolSize = SignalProtocol.SamplesPerSymbol;

    internal TapeFrame? Push(
        ReadOnlySpan<float> left,
        ReadOnlySpan<float> right,
        double? symbolSizeHint = null,
        string? preferredChannel = null)
    {
        _samples.Append(left, right);
        var maxSamples = (int)Math.Ceiling(SignalProtocol.FrameSymbols * SignalProtocol.SymbolSizes.Max() * 3);
        if (_samples.Count > maxSamples) _samples.RetainTail(maxSamples);
        var searchSizes = SearchSizes(symbolSizeHint);

        if (_locked)
        {
            var lockedSizes = SearchSizes(symbolSizeHint ?? _lockedSymbolSize);
            var expectedSamples = (int)Math.Ceiling(SignalProtocol.FrameSymbols * lockedSizes.Min());
            if (_samples.Count < expectedSamples) return null;
            var snapshot = _samples.Snapshot();
            var locked = FindPreferredChannel(
                snapshot.Left,
                snapshot.Right,
                preferredChannel,
                (samples, label) => FindFrameNearStart(samples, label, lockedSizes));
            if (locked is not null)
            {
                Accept(locked);
                return locked.Frame;
            }
            var requiredSamples = (int)Math.Ceiling(SignalProtocol.FrameSymbols * lockedSizes.Max()) + LockedSearchMargin;
            if (_samples.Count < requiredSamples) return null;
            _locked = false;
            _samples.RetainTail((int)Math.Ceiling(SignalProtocol.FrameSymbols * SignalProtocol.SymbolSizes.Max()));
            return null;
        }

        // One complete frame may start anywhere within the retained tail. Wait
        // for two full frames before the expensive acquisition scan, then keep
        // one frame of overlap if the scan fails. This bounds acquisition work
        // to roughly one search per frame instead of one per capture callback.
        var acquisitionSamples = (int)Math.Ceiling(SignalProtocol.FrameSymbols * searchSizes.Max() * 2);
        if (_samples.Count < acquisitionSamples) return null;
        var acquisition = _samples.Snapshot();
        var best = FindPreferredChannel(
            acquisition.Left,
            acquisition.Right,
            preferredChannel,
            (samples, label) => FindFrameInChannel(samples, label, searchSizes));
        if (best is not null)
        {
            Accept(best);
            return best.Frame;
        }

        _samples.RetainTail((int)Math.Ceiling(SignalProtocol.FrameSymbols * SignalProtocol.SymbolSizes.Max()));
        return null;
    }

    internal void Reset()
    {
        _samples.Reset();
        _locked = false;
        _lockedSymbolSize = SignalProtocol.SamplesPerSymbol;
    }

    private void Accept(FrameCandidate candidate)
    {
        _samples.Consume(candidate.End);
        _locked = true;
        _lockedSymbolSize = candidate.SamplesPerSymbol;
    }

    private static double[] SearchSizes(double? hint)
    {
        if (!hint.HasValue) return SignalProtocol.SymbolSizes;
        var center = Math.Clamp(hint.Value, 34d, 45d);
        return new[] { center, center - 0.12, center + 0.12, center - 0.24, center + 0.24 }
            .Select(value => Math.Clamp(value, 34d, 45d))
            .Distinct()
            .ToArray();
    }

    private static FrameCandidate? FindPreferredChannel(
        float[] left,
        float[] right,
        string? preferredChannel,
        Func<float[], string, FrameCandidate?> find)
    {
        var preferRight = string.Equals(preferredChannel, "R", StringComparison.OrdinalIgnoreCase);
        var first = preferRight ? find(right, "R") : find(left, "L");
        if (first is not null) return first;
        return preferRight ? find(left, "L") : find(right, "R");
    }

    private static FrameCandidate? FindFrameNearStart(float[] samples, string label, IReadOnlyList<double> symbolSizes)
    {
        var decoded = new List<FrameCandidate>();
        foreach (var symbolSize in symbolSizes)
        {
            var maxStart = Math.Min(180, samples.Length - (int)Math.Ceiling(SignalProtocol.FrameSymbols * symbolSize));
            if (maxStart < 0) continue;
            SearchCandidate? best = null;
            for (var start = 0; start <= maxStart; start += 6)
            {
                var score = HeaderScore(samples, start, symbolSize);
                if (best is null || score > best.Score) best = new SearchCandidate(start, symbolSize, score);
            }
            if (best is null || best.Score < SignalProtocol.HeaderSymbols.Length + 0.05) continue;
            foreach (var refined in RefineCandidates(samples, best))
            {
                var needed = refined.Start + (int)Math.Ceiling(SignalProtocol.FrameSymbols * refined.SamplesPerSymbol);
                if (needed > samples.Length) continue;
                var frame = DecodeFrame(samples, refined.Start, refined.SamplesPerSymbol, label);
                if (frame is not null) decoded.Add(new FrameCandidate(frame, refined.Start, needed, refined.SamplesPerSymbol));
            }
        }
        return decoded
            .OrderBy(result => result.Start)
            .ThenByDescending(result => Quality(result.Frame))
            .FirstOrDefault();
    }

    private static FrameCandidate? FindFrameInChannel(float[] samples, string label, IReadOnlyList<double> symbolSizes)
    {
        var candidates = new List<SearchCandidate>();
        var minSize = symbolSizes.Min();
        var maxStart = Math.Min(
            samples.Length - (int)Math.Ceiling(SignalProtocol.FrameSymbols * minSize),
            SignalProtocol.FrameSymbols * SignalProtocol.SamplesPerSymbol);
        if (maxStart < 0) return null;

        foreach (var symbolSize in symbolSizes.Distinct())
        {
            var step = Math.Max(5, (int)Math.Round(symbolSize / 4d));
            for (var start = 0; start <= maxStart; start += step)
            {
                var score = HeaderScore(samples, start, symbolSize);
                if (score < SignalProtocol.HeaderSymbols.Length + 0.05) continue;
                candidates.Add(new SearchCandidate(start, symbolSize, score));
                candidates.Sort((a, b) => b.Score.CompareTo(a.Score));
                if (candidates.Count > 10) candidates.RemoveAt(candidates.Count - 1);
            }
        }

        var decoded = new List<FrameCandidate>();
        var attempted = new HashSet<string>();
        foreach (var candidate in candidates)
        {
            foreach (var refined in RefineCandidates(samples, candidate))
            {
                var key = $"{refined.Start}:{refined.SamplesPerSymbol:F3}";
                if (!attempted.Add(key)) continue;
                var needed = refined.Start + (int)Math.Ceiling(SignalProtocol.FrameSymbols * refined.SamplesPerSymbol);
                if (needed > samples.Length) continue;
                var frame = DecodeFrame(samples, refined.Start, refined.SamplesPerSymbol, label);
                if (frame is not null) decoded.Add(new FrameCandidate(frame, refined.Start, needed, refined.SamplesPerSymbol));
            }
        }
        return decoded
            .OrderBy(result => result.Start)
            .ThenByDescending(result => Quality(result.Frame))
            .FirstOrDefault();
    }

    private static TapeFrame? DecodeFrame(float[] samples, int start, double samplesPerSymbol, string label)
    {
        var speed = SignalProtocol.SamplesPerSymbol / (double)samplesPerSymbol;
        var symbols = new int[SignalProtocol.FrameSymbols];
        var confidence = 0d;
        for (var index = 0; index < symbols.Length; index++)
        {
            var classified = ClassifySymbol(samples, start + index * samplesPerSymbol, samplesPerSymbol, speed);
            symbols[index] = classified.Symbol;
            confidence += classified.Confidence;
        }
        for (var index = 0; index < SignalProtocol.PreambleSymbols; index++)
        {
            if (symbols[index] != (index % 2 == 0 ? 0 : 3)) return null;
        }

        var bits = new List<int>((SignalProtocol.SyncSymbols + SignalProtocol.PayloadBytes * 7) * 2);
        for (var index = SignalProtocol.PreambleSymbols; index < symbols.Length; index++)
        {
            var pair = SymbolToPair(symbols[index]);
            bits.Add(pair.A);
            bits.Add(pair.B);
        }
        var sync = BitsToByte(bits, 0) << 8 | BitsToByte(bits, 8);
        if (sync != SignalProtocol.SyncWord) return null;
        var decoded = DecodePayload(bits.Skip(16).Take(SignalProtocol.PayloadBytes * 14).ToArray());
        if (decoded is null) return null;
        return UnpackFrame(decoded.Value.Bytes, decoded.Value.CorrectedBits, confidence / symbols.Length, label);
    }

    private static TapeFrame? UnpackFrame(byte[] bytes, int correctedBits, double confidence, string label)
    {
        if (bytes.Length != SignalProtocol.PayloadBytes || bytes[0] != SignalProtocol.Version) return null;
        var expected = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(34, 4));
        if (Crc32(bytes.AsSpan(0, 34)) != expected) return null;
        var timelineMs = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4, 4));
        var trackId = BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(8, 8)).ToString();
        var sourceMs = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(16, 4));
        var gainDb = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(20, 2)) / 100d;
        var targetTimeline = timelineMs + BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(22, 2)) * 10L;
        var targetDb = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(24, 2)) / 100d;
        var nextTrackId = BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(26, 8)).ToString();
        return new TapeFrame(
            bytes[0], bytes[1], BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(2, 2)),
            timelineMs, trackId, sourceMs, gainDb, targetTimeline, targetDb, nextTrackId,
            correctedBits, confidence, label);
    }

    internal static InputMetrics Analyze(float[] left, float[] right, int sampleRate, double noiseGateDb)
    {
        var channels = new List<ChannelMetrics>
        {
            AnalyzeChannel(left, "L", sampleRate, noiseGateDb)
        };
        if (!ReferenceEquals(left, right)) channels.Add(AnalyzeChannel(right, "R", sampleRate, noiseGateDb));
        var strongest = channels.OrderByDescending(channel => channel.PilotDb).First();
        var levelDb = channels.Max(channel => channel.LevelDb);
        return new InputMetrics(
            channels, levelDb, levelDb > noiseGateDb, noiseGateDb,
            channels.Any(channel => channel.PilotDetected), strongest.PilotDb,
            strongest.PilotHz, strongest.Label);
    }

    private static ChannelMetrics AnalyzeChannel(float[] samples, string label, int sampleRate, double noiseGateDb)
    {
        var pilotDb = -120d;
        var pilotHz = 6_000d;
        for (var frequency = 5_500; frequency <= 6_500; frequency += 25)
        {
            var db = AmplitudeDb(samples, frequency, sampleRate);
            if (db <= pilotDb) continue;
            pilotDb = db;
            pilotHz = frequency;
        }
        var neighboringDb = Math.Max(
            AmplitudeDb(samples, Math.Max(100, pilotHz - 300), sampleRate),
            AmplitudeDb(samples, pilotHz + 300, sampleRate));
        var levelDb = RmsDb(samples);
        var detected = levelDb > noiseGateDb && pilotDb > -65 && pilotDb - neighboringDb >= 3;
        return new ChannelMetrics(label, levelDb, pilotDb, pilotHz, detected);
    }

    private static (int Symbol, double Confidence) ClassifySymbol(
        float[] samples, double start, double samplesPerSymbol, double speed)
    {
        var sampleStart = (int)Math.Round(start);
        var length = Math.Max(32, (int)Math.Round(samplesPerSymbol));
        var best = 0;
        var bestPower = double.NegativeInfinity;
        var totalPower = 0d;
        for (var index = 0; index < SignalProtocol.Tones.Length; index++)
        {
            var power = GoertzelPower(samples, sampleStart, length, SignalProtocol.Tones[index] * speed, SignalProtocol.SampleRate);
            totalPower += power;
            if (power <= bestPower) continue;
            bestPower = power;
            best = index;
        }
        return (best, bestPower / Math.Max(1e-9, totalPower));
    }

    private static double HeaderScore(float[] samples, int start, double samplesPerSymbol)
    {
        var speed = SignalProtocol.SamplesPerSymbol / (double)samplesPerSymbol;
        var score = 0d;
        var confidence = 0d;
        for (var index = 0; index < SignalProtocol.HeaderSymbols.Length; index++)
        {
            var classified = ClassifySymbol(samples, start + index * samplesPerSymbol, samplesPerSymbol, speed);
            if (classified.Symbol == SignalProtocol.HeaderSymbols[index]) score += 1;
            confidence += classified.Confidence;
        }
        return score + confidence / SignalProtocol.HeaderSymbols.Length;
    }

    private static IReadOnlyList<SearchCandidate> RefineCandidates(float[] samples, SearchCandidate candidate)
    {
        var refined = new List<SearchCandidate>();
        for (var sizeStep = -8; sizeStep <= 8; sizeStep++)
        {
            var samplesPerSymbol = Math.Clamp(candidate.SamplesPerSymbol + sizeStep * 0.01, 34d, 45d);
            for (var startDelta = -6; startDelta <= 6; startDelta++)
            {
                var start = Math.Max(0, candidate.Start + startDelta);
                var score = HeaderScore(samples, start, samplesPerSymbol);
                if (score >= SignalProtocol.HeaderSymbols.Length + 0.05)
                    refined.Add(new SearchCandidate(start, samplesPerSymbol, score));
            }
        }
        return refined.OrderByDescending(result => result.Score).Take(4).ToArray();
    }

    private static double GoertzelPower(float[] samples, int start, int length, double frequency, int sampleRate)
    {
        var omega = 2 * Math.PI * frequency / sampleRate;
        var coefficient = 2 * Math.Cos(omega);
        var q1 = 0d;
        var q2 = 0d;
        for (var index = 0; index < length; index++)
        {
            var sampleIndex = start + index;
            var sample = sampleIndex >= 0 && sampleIndex < samples.Length ? samples[sampleIndex] : 0;
            var q0 = coefficient * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }
        return q1 * q1 + q2 * q2 - coefficient * q1 * q2;
    }

    private static double AmplitudeDb(float[] samples, double frequency, int sampleRate)
    {
        if (samples.Length == 0) return -120;
        var power = GoertzelPower(samples, 0, samples.Length, frequency, sampleRate);
        var amplitude = 2 * Math.Sqrt(Math.Max(0, power)) / samples.Length;
        return 20 * Math.Log10(Math.Max(1e-6, amplitude));
    }

    private static double RmsDb(float[] samples)
    {
        if (samples.Length == 0) return -120;
        var sum = samples.Sum(sample => sample * sample);
        return 20 * Math.Log10(Math.Max(1e-6, Math.Sqrt(sum / samples.Length)));
    }

    private static (byte[] Bytes, int CorrectedBits)? DecodePayload(int[] bits)
    {
        if (bits.Length == 0 || bits.Length % 14 != 0) return null;
        var bytes = new byte[bits.Length / 14];
        var corrected = 0;
        for (var index = 0; index < bytes.Length; index++)
        {
            var high = DecodeHamming(bits.AsSpan(index * 14, 7));
            var low = DecodeHamming(bits.AsSpan(index * 14 + 7, 7));
            corrected += high.Corrected ? 1 : 0;
            corrected += low.Corrected ? 1 : 0;
            bytes[index] = (byte)(high.Nibble << 4 | low.Nibble);
        }
        return (bytes, corrected);
    }

    private static (int Nibble, bool Corrected) DecodeHamming(ReadOnlySpan<int> input)
    {
        Span<int> bits = stackalloc int[7];
        input.CopyTo(bits);
        var s1 = bits[0] ^ bits[2] ^ bits[4] ^ bits[6];
        var s2 = bits[1] ^ bits[2] ^ bits[5] ^ bits[6];
        var s4 = bits[3] ^ bits[4] ^ bits[5] ^ bits[6];
        var syndrome = s1 | s2 << 1 | s4 << 2;
        if (syndrome > 0) bits[syndrome - 1] ^= 1;
        return ((bits[2] << 3) | (bits[4] << 2) | (bits[5] << 1) | bits[6], syndrome > 0);
    }

    private static (int A, int B) SymbolToPair(int symbol) => symbol switch
    {
        0 => (0, 0),
        1 => (0, 1),
        2 => (1, 1),
        3 => (1, 0),
        _ => (0, 0)
    };

    private static int BitsToByte(IReadOnlyList<int> bits, int offset)
    {
        var value = 0;
        for (var index = 0; index < 8; index++) value = value << 1 | bits[offset + index];
        return value;
    }

    private static uint Crc32(ReadOnlySpan<byte> bytes)
    {
        var crc = 0xffffffffu;
        foreach (var value in bytes)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++) crc = (crc & 1) != 0 ? 0xedb88320u ^ crc >> 1 : crc >> 1;
        }
        return crc ^ 0xffffffffu;
    }

    private static double Quality(TapeFrame frame) => frame.Confidence - frame.CorrectedBits * 0.002;
    private sealed record SearchCandidate(int Start, double SamplesPerSymbol, double Score);
    private sealed record FrameCandidate(TapeFrame Frame, int Start, int End, double SamplesPerSymbol);

    private sealed class StereoSampleBuffer
    {
        private float[] _left = new float[32_768];
        private float[] _right = new float[32_768];
        private int _start;

        internal int Count { get; private set; }

        internal void Append(ReadOnlySpan<float> left, ReadOnlySpan<float> right)
        {
            if (left.Length == 0) return;
            EnsureSpace(left.Length);
            var writeAt = _start + Count;
            left.CopyTo(_left.AsSpan(writeAt, left.Length));
            var effectiveRight = right.Length == left.Length ? right : left;
            effectiveRight.CopyTo(_right.AsSpan(writeAt, left.Length));
            Count += left.Length;
        }

        internal (float[] Left, float[] Right) Snapshot()
        {
            var left = new float[Count];
            var right = new float[Count];
            _left.AsSpan(_start, Count).CopyTo(left);
            _right.AsSpan(_start, Count).CopyTo(right);
            return (left, right);
        }

        internal void Consume(int count)
        {
            var consumed = Math.Clamp(count, 0, Count);
            _start += consumed;
            Count -= consumed;
            if (Count == 0) _start = 0;
        }

        internal void RetainTail(int count)
        {
            if (Count <= count) return;
            Consume(Count - Math.Max(0, count));
        }

        internal void Reset()
        {
            _start = 0;
            Count = 0;
        }

        private void EnsureSpace(int additional)
        {
            var required = Count + additional;
            if (_start + required <= _left.Length) return;
            if (required <= _left.Length)
            {
                _left.AsSpan(_start, Count).CopyTo(_left);
                _right.AsSpan(_start, Count).CopyTo(_right);
                _start = 0;
                return;
            }
            var capacity = Math.Max(required, _left.Length * 2);
            var left = new float[capacity];
            var right = new float[capacity];
            _left.AsSpan(_start, Count).CopyTo(left);
            _right.AsSpan(_start, Count).CopyTo(right);
            _left = left;
            _right = right;
            _start = 0;
        }
    }
}
