using System.Text.Json;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace CassettePilot.AudioHost;

internal sealed class NativeEditorPlayerEngine : IDisposable
{
    private static readonly HashSet<string> SupportedQualityLevels =
    [
        "best", "standard", "higher", "exhigh", "lossless", "hires",
        "jyeffect", "sky", "dolby", "jymaster"
    ];
    private readonly Uri _apiBase;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(12) };
    private readonly Action<string, object?> _emit;
    private readonly Channel<(EditorPlaybackFrame Frame, int Generation)> _frames = Channel.CreateBounded<(EditorPlaybackFrame, int)>(
        new BoundedChannelOptions(8)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });
    private readonly CancellationTokenSource _cancellation = new();
    private readonly Dictionary<string, TrackPlayer> _players = [];
    private readonly HashSet<string> _unavailableClipIds = [];
    private readonly object _sync = new();
    private readonly Task _frameWorker;
    private EditorPlaybackFrame? _currentFrame;
    private string? _outputDeviceId;
    private string _quality = "best";
    private int _generation;

    internal NativeEditorPlayerEngine(Uri apiBase, Action<string, object?> emit)
    {
        _apiBase = apiBase;
        _emit = emit;
        _frameWorker = Task.Run(() => FrameLoop(_cancellation.Token));
    }

    internal void PostFrame(EditorPlaybackFrame frame)
    {
        int generation;
        lock (_sync) generation = _generation;
        _frames.Writer.TryWrite((frame, generation));
    }

    internal void Pause()
    {
        lock (_sync)
        {
            _generation += 1;
            foreach (var player in _players.Values) player.Pause();
            if (_currentFrame is not null) _currentFrame = _currentFrame with { ShouldPlay = false };
        }
    }

    internal void SetOutputDevice(string? deviceId)
    {
        lock (_sync)
        {
            if (_outputDeviceId == deviceId) return;
            _outputDeviceId = deviceId;
            ResetTracksLocked();
        }
    }

    internal void SetQuality(string? quality)
    {
        var normalized = quality?.ToLowerInvariant() ?? "best";
        if (!SupportedQualityLevels.Contains(normalized)) normalized = "best";
        lock (_sync)
        {
            if (_quality == normalized) return;
            _quality = normalized;
            ResetTracksLocked();
        }
    }

    internal void ResetTracks()
    {
        lock (_sync) ResetTracksLocked();
    }

    private void ResetTracksLocked()
    {
        _generation += 1;
        foreach (var player in _players.Values) player.Dispose();
        _players.Clear();
        _unavailableClipIds.Clear();
        _currentFrame = null;
    }

    private async Task FrameLoop(CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var item in _frames.Reader.ReadAllAsync(cancellationToken))
            {
                await ApplyFrame(item.Frame, item.Generation, cancellationToken);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            _emit("error", new { scope = "editorPlayer", message = error.Message });
        }
    }

    private async Task ApplyFrame(EditorPlaybackFrame frame, int generation, CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            if (generation != _generation) return;
        }
        var current = await EnsureLoaded(frame, generation, cancellationToken);
        if (current is null) return;

        lock (_sync)
        {
            if (generation != _generation) return;
            var changedClip = _currentFrame?.ClipId != frame.ClipId;
            var jumped = _currentFrame is null
                || changedClip
                || Math.Abs(current.Position.TotalMilliseconds - frame.SourceMs) > 1_250;
            _currentFrame = frame;
            foreach (var pair in _players)
            {
                if (pair.Key != frame.ClipId) pair.Value.Pause();
            }
            if (jumped) current.Seek(frame.SourceMs);
            current.Volume = DbToLinear(frame.GainDb);
            if (frame.ShouldPlay) current.Play();
            else current.Pause();
        }
    }

    private async Task<TrackPlayer?> EnsureLoaded(
        EditorPlaybackFrame frame,
        int generation,
        CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            if (_players.TryGetValue(frame.ClipId, out var existing)) return existing;
            if (_unavailableClipIds.Contains(frame.ClipId)) return null;
        }

        try
        {
            var source = await ResolveSource(frame, cancellationToken);
            var player = await Task.Run(
                () => new TrackPlayer(frame.ClipId, source, _outputDeviceId),
                cancellationToken);
            lock (_sync)
            {
                if (generation != _generation)
                {
                    player.Dispose();
                    return null;
                }
                if (_players.TryGetValue(frame.ClipId, out var duplicate))
                {
                    player.Dispose();
                    return duplicate;
                }
                _players[frame.ClipId] = player;
                _emit("editorTrackReady", new { clipId = frame.ClipId, trackId = frame.TrackId });
                return player;
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            lock (_sync) _unavailableClipIds.Add(frame.ClipId);
            _emit("error", new
            {
                scope = "editorTrack",
                clipId = frame.ClipId,
                trackId = frame.TrackId,
                message = error.Message
            });
            return null;
        }
    }

    private async Task<string> ResolveSource(EditorPlaybackFrame frame, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(frame.AudioUrl))
        {
            if (Uri.TryCreate(frame.AudioUrl, UriKind.Absolute, out var absolute))
            {
                return absolute.IsFile ? absolute.LocalPath : absolute.ToString();
            }
            return new Uri(_apiBase, frame.AudioUrl).ToString();
        }
        if (string.IsNullOrWhiteSpace(frame.TrackId) || frame.TrackId == "0")
        {
            throw new InvalidOperationException("This editor clip has no playable audio source.");
        }

        string quality;
        lock (_sync) quality = _quality;
        var endpoint = new Uri(
            _apiBase,
            $"/api/netease/url?id={Uri.EscapeDataString(frame.TrackId)}&level={Uri.EscapeDataString(quality)}");
        using var response = await _http.GetAsync(endpoint, cancellationToken);
        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        using var document = JsonDocument.Parse(json);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(ReadMessage(document.RootElement)
                ?? $"NetEase request failed ({(int)response.StatusCode}).");
        }
        var url = ReadUrl(document.RootElement);
        return !string.IsNullOrWhiteSpace(url)
            ? url
            : throw new InvalidOperationException("NetEase returned no playable URL.");
    }

    private static string? ReadUrl(JsonElement root)
    {
        if (root.TryGetProperty("url", out var direct) && direct.ValueKind == JsonValueKind.String)
        {
            return direct.GetString();
        }
        if (root.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Array
            && data.GetArrayLength() > 0)
        {
            var first = data[0];
            if (first.TryGetProperty("url", out var nested) && nested.ValueKind == JsonValueKind.String)
            {
                return nested.GetString();
            }
        }
        return null;
    }

    private static string? ReadMessage(JsonElement root)
    {
        foreach (var name in new[] { "message", "detail", "error" })
        {
            if (root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }
        }
        return null;
    }

    private static float DbToLinear(double db) => (float)Math.Clamp(Math.Pow(10, db / 20), 0, 1);

    public void Dispose()
    {
        _cancellation.Cancel();
        try { _frameWorker.Wait(1_000); } catch { }
        lock (_sync) ResetTracksLocked();
        _http.Dispose();
        _cancellation.Dispose();
    }

    private sealed class TrackPlayer : IDisposable
    {
        private readonly MediaFoundationReader _reader;
        private readonly SampleChannel _channel;
        private readonly GatedSampleProvider _gate;
        private readonly WasapiOut _output;

        internal TrackPlayer(string clipId, string source, string? outputDeviceId)
        {
            ClipId = clipId;
            _reader = new MediaFoundationReader(source);
            _channel = new SampleChannel(_reader, true);
            _gate = new GatedSampleProvider(_channel);
            var device = DeviceCatalog.Resolve(DataFlow.Render, outputDeviceId);
            _output = new WasapiOut(device, AudioClientShareMode.Shared, true, 120);
            _output.Init(_gate);
        }

        internal string ClipId { get; }
        internal TimeSpan Position => _reader.CurrentTime;
        internal float Volume { get => _channel.Volume; set => _channel.Volume = value; }

        internal void Play()
        {
            _gate.Enabled = true;
            if (_output.PlaybackState != PlaybackState.Playing) _output.Play();
        }

        internal void Pause()
        {
            _gate.Enabled = false;
            if (_output.PlaybackState != PlaybackState.Stopped) _output.Stop();
        }

        internal void Seek(long sourceMs)
        {
            _reader.CurrentTime = TimeSpan.FromMilliseconds(Math.Max(0, sourceMs));
        }

        public void Dispose()
        {
            _output.Stop();
            _output.Dispose();
            _reader.Dispose();
        }
    }

    private sealed class GatedSampleProvider : ISampleProvider
    {
        private readonly ISampleProvider _source;
        private volatile bool _enabled;

        internal GatedSampleProvider(ISampleProvider source) => _source = source;

        public WaveFormat WaveFormat => _source.WaveFormat;
        internal bool Enabled { get => _enabled; set => _enabled = value; }

        public int Read(float[] buffer, int offset, int count)
        {
            if (_enabled) return _source.Read(buffer, offset, count);
            Array.Clear(buffer, offset, count);
            return count;
        }
    }
}
