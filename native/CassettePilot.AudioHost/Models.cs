using System.Text.Json;
using System.Text.Json.Serialization;

namespace CassettePilot.AudioHost;

internal static class JsonProtocol
{
    internal static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}

internal sealed record AudioDeviceInfo(string Id, string Label, bool IsDefault = false);

internal sealed record TapeFrame(
    int Version,
    int Flags,
    int Sequence,
    long TimelineMs,
    string TrackId,
    long SourceMs,
    double GainDb,
    long GainTargetTimelineMs,
    double GainTargetDb,
    string NextTrackId,
    int CorrectedBits,
    double Confidence,
    string InputChannel)
{
    internal bool RequestsPlayback => (Flags & 1) != 0 && (Flags & 8) == 0;
}

internal sealed record ChannelMetrics(
    string Label,
    double LevelDb,
    double PilotDb,
    double PilotHz,
    bool PilotDetected);

internal sealed record InputMetrics(
    IReadOnlyList<ChannelMetrics> Channels,
    double LevelDb,
    bool InputDetected,
    double NoiseGateDb,
    bool PilotDetected,
    double PilotDb,
    double PilotHz,
    string PilotChannel);

internal sealed record PlayerStatus(
    string? TrackId,
    string? NextTrackId,
    long SourceMs,
    double GainDb,
    bool Playing,
    bool CarrierLive);

internal sealed class NativeCommand
{
    public string Type { get; init; } = string.Empty;
    public string? InputDeviceId { get; init; }
    public string? OutputDeviceId { get; init; }
    public string? Quality { get; init; }
    public double? NoiseGateDb { get; init; }
}
