using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace CassettePilot.AudioHost;

internal sealed class NativePlayerEngine : IDisposable
{
    private static readonly HashSet<string> SupportedQualityLevels =
    [
        "best", "standard", "higher", "exhigh", "lossless", "hires",
        "jyeffect", "sky", "dolby", "jymaster"
    ];
    private readonly Uri _apiBase;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(12) };
    private readonly Action<string, object?> _emit;
    private readonly Channel<TapeFrame> _frames = Channel.CreateBounded<TapeFrame>(new BoundedChannelOptions(8)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
        SingleWriter = false
    });
    private readonly CancellationTokenSource _cancellation = new();
    private readonly Dictionary<string, TrackPlayer> _players = [];
    private readonly HashSet<string> _unavailableTrackIds = [];
    private readonly object _sync = new();
    private readonly Task _frameWorker;
    private readonly Timer _gainTimer;
    private TapeFrame? _currentFrame;
    private string? _outputDeviceId;
    private string _quality = "best";
    private bool _carrierLive;

    internal NativePlayerEngine(Uri apiBase, Action<string, object?> emit)
    {
        _apiBase = apiBase;
        _emit = emit;
        _frameWorker = Task.Run(() => FrameLoop(_cancellation.Token));
        _gainTimer = new Timer(_ => UpdateGain(), null, 25, 25);
    }

    internal void PostFrame(TapeFrame frame) => _frames.Writer.TryWrite(frame);

    internal void SetCarrier(bool live)
    {
        lock (_sync)
        {
            if (_carrierLive == live) return;
            _carrierLive = live;
            if (!live)
            {
                foreach (var loaded in _players.Values) loaded.Pause();
            }
            // Carrier acquisition is always triggered by a newly decoded frame,
            // which is already queued for ApplyFrame. Keep the old output muted
            // until that frame has selected and sought the correct track; playing
            // here would briefly resume the pre-pause position.
            EmitStatus();
        }
    }

    internal void SetOutputDevice(string? deviceId)
    {
        lock (_sync)
        {
            if (_outputDeviceId == deviceId) return;
            _outputDeviceId = deviceId;
            foreach (var player in _players.Values) player.Dispose();
            _players.Clear();
            _currentFrame = null;
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
            foreach (var player in _players.Values) player.Dispose();
            _players.Clear();
            _unavailableTrackIds.Clear();
            _currentFrame = null;
        }
    }

    internal void ResetTracks()
    {
        lock (_sync)
        {
            foreach (var player in _players.Values) player.Dispose();
            _players.Clear();
            _unavailableTrackIds.Clear();
            _currentFrame = null;
        }
    }

    private async Task FrameLoop(CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var frame in _frames.Reader.ReadAllAsync(cancellationToken)) await ApplyFrame(frame, cancellationToken);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { _emit("error", new { scope = "player", message = error.Message }); }
    }

    private async Task ApplyFrame(TapeFrame frame, CancellationToken cancellationToken)
    {
        if (frame.TrackId == "0") return;
        var current = await EnsureLoaded(frame.TrackId, cancellationToken);
        if (current is null) return;
        if (frame.NextTrackId != "0") _ = EnsureLoaded(frame.NextTrackId, cancellationToken);

        lock (_sync)
        {
            var previousTrackId = _currentFrame?.TrackId;
            var changedTrack = previousTrackId != frame.TrackId;
            var jumped = _currentFrame is null
                || changedTrack
                || Math.Abs(ExpectedSourceMs(_currentFrame) - frame.SourceMs) > 1_250;
            _currentFrame = frame;
            foreach (var pair in _players)
            {
                if (pair.Key != frame.TrackId) pair.Value.Pause();
            }
            if (jumped) current.Seek(frame.SourceMs);
            current.Volume = DbToLinear(frame.GainDb);
            if (_carrierLive && frame.RequestsPlayback) current.Play();
            else current.Pause();
            EmitStatus();
        }
    }

    private long ExpectedSourceMs(TapeFrame frame)
    {
        if (!_players.TryGetValue(frame.TrackId, out var player) || !player.IsPlaying) return frame.SourceMs;
        return (long)player.Position.TotalMilliseconds;
    }

    private async Task<TrackPlayer?> EnsureLoaded(string trackId, CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            if (_players.TryGetValue(trackId, out var existing)) return existing;
            if (_unavailableTrackIds.Contains(trackId)) return null;
        }
        try
        {
            string quality;
            lock (_sync) quality = _quality;
            var endpoint = new Uri(
                _apiBase,
                $"/api/netease/url?id={Uri.EscapeDataString(trackId)}&level={Uri.EscapeDataString(quality)}");
            using var response = await _http.GetAsync(endpoint, cancellationToken);
            var json = await response.Content.ReadAsStringAsync(cancellationToken);
            using var document = JsonDocument.Parse(json);
            if (!response.IsSuccessStatusCode)
            {
                var message = ReadMessage(document.RootElement);
                if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                {
                    throw new TrackUnavailableException(message ?? "No playable URL is available for this account and track.");
                }
                throw new InvalidOperationException(message ?? $"NetEase request failed ({(int)response.StatusCode}).");
            }
            var url = ReadUrl(document.RootElement);
            if (string.IsNullOrWhiteSpace(url)) throw new TrackUnavailableException("NetEase returned no playable URL.");
            var resolvedQuality = ReadResolvedQuality(document.RootElement) ?? quality;
            var player = await Task.Run(() => new TrackPlayer(trackId, url, _outputDeviceId), cancellationToken);
            lock (_sync)
            {
                if (_players.TryGetValue(trackId, out var duplicate))
                {
                    player.Dispose();
                    return duplicate;
                }
                _players[trackId] = player;
                _emit("trackReady", new { trackId, quality = resolvedQuality });
                return player;
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            var shouldEmit = true;
            if (error is TrackUnavailableException)
            {
                lock (_sync) shouldEmit = _unavailableTrackIds.Add(trackId);
            }
            if (shouldEmit) _emit("error", new { scope = "track", trackId, message = error.Message });
            return null;
        }
    }

    private static string? ReadUrl(JsonElement root)
    {
        if (root.TryGetProperty("url", out var direct) && direct.ValueKind == JsonValueKind.String) return direct.GetString();
        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array && data.GetArrayLength() > 0)
        {
            var first = data[0];
            if (first.TryGetProperty("url", out var nested) && nested.ValueKind == JsonValueKind.String) return nested.GetString();
        }
        return null;
    }

    private static string? ReadResolvedQuality(JsonElement root)
    {
        if (!root.TryGetProperty("resolution", out var resolution) || resolution.ValueKind != JsonValueKind.Object) return null;
        if (!resolution.TryGetProperty("actual", out var actual) || actual.ValueKind != JsonValueKind.String) return null;
        return actual.GetString();
    }

    private static string? ReadMessage(JsonElement root)
    {
        foreach (var name in new[] { "message", "detail", "error" })
        {
            if (root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String) return value.GetString();
        }
        return null;
    }

    private void UpdateGain()
    {
        lock (_sync)
        {
            if (_currentFrame is null || !_players.TryGetValue(_currentFrame.TrackId, out var player)) return;
            var currentTimelineMs = _currentFrame.TimelineMs;
            if (player.IsPlaying) currentTimelineMs += (long)Math.Max(0, player.Position.TotalMilliseconds - _currentFrame.SourceMs);
            var span = Math.Max(1, _currentFrame.GainTargetTimelineMs - _currentFrame.TimelineMs);
            var progress = Math.Clamp((currentTimelineMs - _currentFrame.TimelineMs) / (double)span, 0, 1);
            var gainDb = _currentFrame.GainDb + (_currentFrame.GainTargetDb - _currentFrame.GainDb) * progress;
            player.Volume = DbToLinear(gainDb);
        }
    }

    private TrackPlayer? ActivePlayer() => _currentFrame is not null && _players.TryGetValue(_currentFrame.TrackId, out var player) ? player : null;

    private void EmitStatus()
    {
        var active = ActivePlayer();
        _emit("playback", new PlayerStatus(
            _currentFrame?.TrackId,
            _currentFrame?.NextTrackId,
            active is null ? 0 : (long)active.Position.TotalMilliseconds,
            _currentFrame?.GainDb ?? 0,
            active?.IsPlaying == true,
            _carrierLive));
    }

    private static float DbToLinear(double db) => (float)Math.Clamp(Math.Pow(10, db / 20), 0, 1);

    private sealed class TrackUnavailableException(string message) : Exception(message);

    public void Dispose()
    {
        _cancellation.Cancel();
        _gainTimer.Dispose();
        try { _frameWorker.Wait(1_000); } catch { }
        lock (_sync)
        {
            foreach (var player in _players.Values) player.Dispose();
            _players.Clear();
        }
        _http.Dispose();
        _cancellation.Dispose();
    }

    private sealed class TrackPlayer : IDisposable
    {
        private readonly MediaFoundationReader _reader;
        private readonly SampleChannel _channel;
        private readonly GatedSampleProvider _gate;
        private readonly WasapiOut _output;

        internal TrackPlayer(string trackId, string url, string? outputDeviceId)
        {
            TrackId = trackId;
            _reader = new MediaFoundationReader(url);
            _channel = new SampleChannel(_reader, true);
            _gate = new GatedSampleProvider(_channel);
            var device = DeviceCatalog.Resolve(DataFlow.Render, outputDeviceId);
            _output = new WasapiOut(device, AudioClientShareMode.Shared, true, 120);
            _output.Init(_gate);
        }

        internal string TrackId { get; }
        internal bool IsPlaying => _gate.Enabled;
        internal TimeSpan Position => _reader.CurrentTime;
        internal float Volume { get => _channel.Volume; set => _channel.Volume = value; }
        internal void Play()
        {
            _gate.Enabled = true;
            if (_output.PlaybackState != PlaybackState.Playing)
            {
                _output.Play();
            }
        }
        internal void Pause()
        {
            _gate.Enabled = false;
            // Flush the native render buffer instead of leaving every previously
            // played WASAPI client alive on synthetic silence. Some endpoints can
            // repeat a damaged final buffer in that state, producing persistent
            // static until real samples arrive again. The reader position remains
            // unchanged, and Play can restart this initialized client in the
            // background without involving Electron or Chromium.
            if (_output.PlaybackState != PlaybackState.Stopped) _output.Stop();
        }
        internal void Seek(long sourceMs) => _reader.CurrentTime = TimeSpan.FromMilliseconds(Math.Max(0, sourceMs));

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
