using System.Diagnostics;
using System.Text.Json;
using NAudio.Wave;

namespace CassettePilot.AudioHost;

internal static class Program
{
    private static readonly object OutputSync = new();

    public static async Task<int> Main(string[] args)
    {
        var apiBaseValue = ReadArgument(args, "--api-base") ?? "http://127.0.0.1:4173";
        if (!Uri.TryCreate(apiBaseValue, UriKind.Absolute, out var apiBase))
        {
            Console.Error.WriteLine("Invalid --api-base value.");
            return 2;
        }

        void Emit(string type, object? payload = null)
        {
            var message = payload is null
                ? new Dictionary<string, object?> { ["type"] = type }
                : JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(payload, JsonProtocol.Options), JsonProtocol.Options)!;
            message["type"] = type;
            lock (OutputSync)
            {
                Console.Out.WriteLine(JsonSerializer.Serialize(message, JsonProtocol.Options));
                Console.Out.Flush();
            }
        }

        var decodeWavePath = ReadArgument(args, "--decode-wav");
        if (!string.IsNullOrWhiteSpace(decodeWavePath)) return DecodeWave(decodeWavePath, Emit);
        if (args.Contains("--self-test-carrier"))
        {
            AudioCaptureEngine.AssertCarrierGateBehavior();
            Emit("carrierTestComplete", new { passed = true });
            return 0;
        }
        if (args.Contains("--self-test-pipeline"))
        {
            StreamingStereoResampler.AssertBehavior();
            Emit("pipelineSelfTestComplete", new { passed = true });
            return 0;
        }
        var livePipelinePath = ReadArgument(args, "--verify-live-pipeline");
        if (!string.IsNullOrWhiteSpace(livePipelinePath))
        {
            var droppedBlock = int.TryParse(ReadArgument(args, "--drop-block"), out var parsedDrop)
                ? parsedDrop
                : -1;
            return VerifyLivePipeline(livePipelinePath, droppedBlock, Emit);
        }

        using var player = new NativePlayerEngine(apiBase, Emit);
        using var capture = new AudioCaptureEngine(Emit, player);
        Emit("ready", new { version = "0.1.0", protocolVersion = SignalProtocol.Version });
        EmitDevices(Emit);

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            try
            {
                var command = JsonSerializer.Deserialize<NativeCommand>(line, JsonProtocol.Options);
                if (command is null) continue;
                switch (command.Type)
                {
                    case "listDevices":
                        EmitDevices(Emit);
                        break;
                    case "startInput":
                        if (command.NoiseGateDb.HasValue) capture.SetNoiseGate(command.NoiseGateDb.Value);
                        if (command.OutputDeviceId is not null) player.SetOutputDevice(command.OutputDeviceId);
                        if (command.Quality is not null) player.SetQuality(command.Quality);
                        capture.Start(command.InputDeviceId);
                        break;
                    case "stopInput":
                        capture.Stop();
                        Emit("inputStopped");
                        break;
                    case "setOutput":
                        player.SetOutputDevice(command.OutputDeviceId);
                        Emit("outputChanged", new { outputDeviceId = command.OutputDeviceId });
                        break;
                    case "setNoiseGate":
                        if (command.NoiseGateDb.HasValue) capture.SetNoiseGate(command.NoiseGateDb.Value);
                        break;
                    case "setQuality":
                        player.SetQuality(command.Quality);
                        Emit("qualityChanged", new { quality = command.Quality });
                        break;
                    case "resetTracks":
                        player.ResetTracks();
                        break;
                    case "shutdown":
                        return 0;
                    default:
                        Emit("error", new { scope = "command", message = $"Unknown command: {command.Type}" });
                        break;
                }
            }
            catch (Exception error)
            {
                Emit("error", new { scope = "command", message = error.Message });
            }
        }
        return 0;
    }

    private static void EmitDevices(Action<string, object?> emit)
    {
        emit("devices", new { inputs = DeviceCatalog.Inputs(), outputs = DeviceCatalog.Outputs() });
    }

    private static string? ReadArgument(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static int DecodeWave(string path, Action<string, object?> emit)
    {
        using var reader = new AudioFileReader(path);
        var decoder = new SignalDecoder();
        var interleaved = new float[4_096 * reader.WaveFormat.Channels];
        var decoded = 0;
        int read;
        while ((read = reader.Read(interleaved, 0, interleaved.Length)) > 0)
        {
            var frames = read / reader.WaveFormat.Channels;
            var left = new float[frames];
            var right = new float[frames];
            for (var index = 0; index < frames; index++)
            {
                left[index] = interleaved[index * reader.WaveFormat.Channels];
                right[index] = reader.WaveFormat.Channels > 1
                    ? interleaved[index * reader.WaveFormat.Channels + 1]
                    : left[index];
            }
            var metrics = SignalDecoder.Analyze(left, right, reader.WaveFormat.SampleRate, -90);
            var symbolSizeHint = metrics.PilotDetected
                ? SignalProtocol.SamplesPerSymbol * 6_000d / metrics.PilotHz
                : (double?)null;
            var frame = decoder.Push(left, right, symbolSizeHint, metrics.PilotChannel);
            while (frame is not null)
            {
                decoded += 1;
                emit("frame", frame);
                frame = decoder.Push([], [], symbolSizeHint, metrics.PilotChannel);
            }
        }
        emit("decodeComplete", new { frames = decoded });
        return decoded > 0 ? 0 : 3;
    }

    private static int VerifyLivePipeline(string path, int droppedBlock, Action<string, object?> emit)
    {
        using var reader = new WaveFileReader(path);
        var decoder = new SignalDecoder();
        var resampler = new StreamingStereoResampler(reader.WaveFormat.SampleRate, SignalProtocol.SampleRate);
        var blockFrames = Math.Max(1, reader.WaveFormat.SampleRate / 50);
        var buffer = new byte[blockFrames * reader.WaveFormat.BlockAlign];
        var stopwatch = Stopwatch.StartNew();
        var decoded = 0;
        var blocks = 0;
        var discontinuities = 0;
        var sourceFrames = 0L;
        var outputFrames = 0L;
        var maximumBlockMs = 0d;
        void ProcessBlock(StereoBlock block, long startedAt)
        {
            outputFrames += block.Left.Length;
            if (block.Left.Length == 0) return;
            var metrics = SignalDecoder.Analyze(
                block.Left,
                block.Right,
                SignalProtocol.SampleRate,
                -90);
            var symbolSizeHint = metrics.PilotDetected
                ? SignalProtocol.SamplesPerSymbol * 6_000d / metrics.PilotHz
                : (double?)null;
            var frame = decoder.Push(
                block.Left,
                block.Right,
                symbolSizeHint,
                metrics.PilotChannel);
            while (frame is not null)
            {
                decoded += 1;
                frame = decoder.Push([], [], symbolSizeHint, metrics.PilotChannel);
            }
            maximumBlockMs = Math.Max(
                maximumBlockMs,
                (Stopwatch.GetTimestamp() - startedAt) * 1_000d / Stopwatch.Frequency);
        }
        int read;
        while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
        {
            blocks += 1;
            sourceFrames += read / reader.WaveFormat.BlockAlign;
            if (blocks == droppedBlock) continue;
            if (blocks == droppedBlock + 1)
            {
                decoder.Reset();
                discontinuities += 1;
            }
            var startedAt = Stopwatch.GetTimestamp();
            var converted = SampleConverter.Convert(buffer.AsSpan(0, read), reader.WaveFormat);
            var resampled = resampler.Push(converted.Left, converted.Right);
            ProcessBlock(resampled, startedAt);
        }
        ProcessBlock(resampler.Flush(), Stopwatch.GetTimestamp());
        stopwatch.Stop();
        var audioMs = sourceFrames * 1_000d / reader.WaveFormat.SampleRate;
        var realtimeRatio = audioMs <= 0 ? 0 : stopwatch.Elapsed.TotalMilliseconds / audioMs;
        emit("pipelineTestComplete", new
        {
            frames = decoded,
            blocks,
            discontinuities,
            sourceFrames,
            outputFrames,
            sourceSampleRate = reader.WaveFormat.SampleRate,
            resampling = !resampler.IsPassthrough,
            audioMs,
            elapsedMs = stopwatch.Elapsed.TotalMilliseconds,
            maximumBlockMs,
            realtimeRatio
        });
        return decoded > 0 && realtimeRatio < 1 ? 0 : 3;
    }
}
