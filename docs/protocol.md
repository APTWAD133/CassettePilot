# Cassette Control Signal v2

## Physical layer

| Property | Value |
|---|---|
| Container | PCM WAV |
| Channels | 2, complete identical frame on L and R |
| Sample rate | 48,000 Hz |
| Sample format | Signed 16-bit little-endian |
| Modulation | Continuous-phase Gray-coded 4-FSK |
| Symbol rate | 1,200 symbols/s |
| Raw data rate | 2,400 bit/s before error correction |
| Data tones | 1.2, 2.4, 3.6, and 4.8 kHz |
| Continuous pilot | 6 kHz at low amplitude |

The symbol mapping is `00` = 1.2 kHz, `01` = 2.4 kHz, `11` = 3.6 kHz,
and `10` = 4.8 kHz. A symbol is exactly 40 samples at 48 kHz, so each tone
completes an integer number of cycles inside a symbol.

Both channels contain the complete signal. They are not halves of a frame. The
decoder treats L and R independently, rejects frames with invalid CRCs, then
selects the valid result with the strongest classification confidence and fewest
corrected Hamming bits. Consequently the same decoder accepts stereo, mono,
summed mono, swapped channels, and either single-channel dropout.

## Frame

Frames contain 286 symbols and last approximately 238.33 ms (about 4.2 frames
per second). They are transmitted without gaps:

```text
12-symbol alternating preamble
16-bit sync word (0xDDAA)
38-byte payload protected with Hamming(7,4)
```

Hamming(7,4) corrects one bit error per codeword. CRC-32 rejects any frame with
remaining payload errors.

### Payload

All multibyte values use little-endian byte order.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | Protocol version (`2`) |
| 1 | 1 | Flags |
| 2 | 2 | Sequence number |
| 4 | 4 | Mixtape timeline position in milliseconds |
| 8 | 8 | Current NetEase track ID |
| 16 | 4 | Current source position in milliseconds |
| 20 | 2 | Current gain in hundredths of a decibel |
| 22 | 2 | Time to next gain target in 10 ms units |
| 24 | 2 | Next gain target in hundredths of a decibel |
| 26 | 8 | Next NetEase track ID, or zero |
| 34 | 4 | CRC-32 of bytes 0–33 |

Flag bits are bit 0 for transport playing, bit 2 for end of timeline, and bit 3
for preroll. There is no two-track transition payload in v2.

The gain target lets the player interpolate volume continuously from the current
frame value to the next authored keypoint instead of waiting for a later frame
and jumping. The next song ID allows playback data to be preloaded.

## Clock policy

The encoded timestamp is a locator, not the music clock. After acquisition, the
player advances on the computer's monotonic clock. Normal cassette wow, flutter,
and accumulated drift do not repeatedly seek the music. A track change or jump
larger than five seconds is confirmed before relocation.

The monotonic clock is advanced whenever a decoded frame arrives as well as by
foreground display updates. Carrier state is evaluated directly on each audio
meter block. Neither transport function depends on `requestAnimationFrame`,
which browsers throttle when the player tab is not focused.

Losing the carrier mutes the active media element but keeps its already-authorized
playback session warm. It remains muted until a new CRC-valid frame reacquires and
relocates the tape clock. Explicit input shutdown, logout, and player reset still
pause and release the media normally.

For a rewind or other relocation, only one media seek may be outstanding. Later
frames update the decoded transport state but cannot overwrite `currentTime`
while the media element still reports that it is seeking. A `seeked` event clears
the bookkeeping early when delivered, but neither playback nor audibility waits
for that event.

The `nextTrackId` preload is active rather than download-only: the next media
element is started muted and looping while the current song plays. Chromium
allows muted background playback, so transition does not require a new audible
`play()` authorization when the tab is hidden.

An arbitrary track first encountered after a cassette swap is also started muted
inside the load operation. The load promise does not resolve until that priming
attempt completes, ensuring relocation never targets a cold media element whose
metadata and playback session have not been initialized.

Relocation does not depend on a `seeked` event to make media audible. The old
position is muted first, `currentTime` is changed, and the requested audible
state is restored synchronously. The media pipeline resumes at the decoded
position when ready even if an occluded renderer defers DOM event delivery.

Starting a muted remote media element is also non-blocking. The player begins
priming as soon as the NetEase URL and output route are available, but it does
not await the `play()` promise before applying later decoded frames. If metadata
is not ready for the first seek attempt, the element remains muted and the next
frame retries the relocation.

The 6 kHz pilot is the transport gate. Playback pauses after 280 ms without the
pilot. This release hysteresis covers several capture blocks and prevents normal
browser scheduling jitter from looking like a stopped deck. Pilot detection
alone cannot start music: after every stopped state, the player first applies a
fresh CRC-valid frame while audio remains paused.

The live detector searches 5.5–6.5 kHz so deck speed error does not move the
pilot outside the acquisition window. Pilot detection, input RMS, and L/R level
metering operate directly on each captured PCM block; frame CRC validation is a
separate stage. The monitor can therefore distinguish no input, ordinary audio,
carrier-only acquisition, and a fully valid frame.

The measured pilot frequency also supplies a fractional samples-per-symbol hint.
Frame search refines that value with a phase accumulator, preventing small deck
speed errors and wow from accumulating a whole-symbol timing slip across a frame.

The adjustable input noise gate defaults to -75 dBFS and ranges from -90 to
-20 dBFS. A pilot candidate is ignored unless its channel level is above this
threshold. The meter continues to show the raw level and marks the configured
gate, making it possible to place the threshold just above a deck's idle noise
or local RF interference without changing the encoded signal.

In the portable Windows app, a native .NET host captures the chosen WASAPI input,
converts it to stereo float PCM, and resamples it to 48 kHz. A high-priority
decoder task performs continuous input/pilot metering, symbol search, Hamming
correction, and CRC validation. It also owns transport state and WASAPI music
output, so Electron renderer scheduling cannot delay stop, rewind, track change,
or cassette replacement. Electron receives meter and frame events only for UI.

The browser-only development fallback retains the `AudioWorklet`, meter worker,
and decoder worker implementation with compatible 2,048-sample capture blocks.

## Lock-in leader and duration

Exports begin with the smallest whole-frame leader that is at least ten seconds:

```text
ceil(10,000 ms / frame_duration) complete frames
```

All but the final leader frame repeat timeline zero with the preroll flag set and
playing cleared. The final leader frame clears preroll and enables playback at
timeline zero. This gives the input and decoder time to establish pilot, symbol,
and frame lock before music begins.

No tail is appended. The final frame may be truncated at the exact authored end;
the preceding complete frame remains authoritative.
