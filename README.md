# CassettePilot

[简体中文](README.zh-CN.md)

CassettePilot is a Windows-first Electron application for authoring cassette control tracks and using a physical cassette deck as a transport controller for authorized music playback. A self-contained .NET audio host handles WASAPI capture, signal decoding, seeking, gain control, and playback independently of the renderer event loop.

Release `0.1.0` is the first standalone repository release.

## Responsible use

This project is independent and is not affiliated with or endorsed by NetEase. Use the music-service integration only with an account, API, content, and actions you are authorized to use. You are responsible for complying with applicable copyright law, recording laws, and music-service terms.

The application does not grant permission to download, record, retain, redistribute, or publicly perform protected audio. The actual-music dubbing path is intended only for audio you own or otherwise have explicit rights to record. The control-signal workflow records data rather than music. This is practical project guidance, not legal advice.

## Features

- Visual two-sided mixtape editor with overwrite editing, trim points, fades, gain automation, snapping, and keyboard shortcuts.
- 48 kHz stereo control-signal generation with carrier, error correction, and CRC validation.
- Native Windows WASAPI input/output with tape-speed recovery and rapid pause on carrier loss.
- Cassette deck and tape diagnostic measurements.
- Embedded or external compatible NetEase provider for authorized search, metadata, login, and playback.
- Encrypted desktop login-cookie storage tied to the current Windows account.
- English and Simplified Chinese interface.
- Portable Windows x64 packaging.

See [docs/protocol.md](docs/protocol.md) for the signal format and physical-layer design.

## Download and run

Download `CassettePilot-0.1.0-x64.exe` from [GitHub Releases](https://github.com/APTWAD133/CassettePilot/releases) when the release is published. The portable executable is self-contained: end users do not need Node.js, npm, the .NET SDK, or an installer.

End-user requirements:

- Windows 10 or newer on x64 hardware.
- A cassette deck and suitable audio interface for physical control and diagnostic workflows.

The executable is currently unsigned, so Windows SmartScreen may show a warning. Verify the release checksum before running it.

## Build and run from source

Development requires Windows on x64 hardware, Node.js 20 or newer with npm, and the .NET 8 SDK.

Install the exact locked dependencies and build the native host:

```powershell
npm ci
npm run build:native
npm start
```

The Electron app starts a private loopback server on an unused port. Renderer Node.js access is disabled, context isolation and sandboxing are enabled, and microphone/speaker-selection permissions are restricted to the app's loopback origin.

For browser-only development:

```powershell
npm ci
npm run dev:web
```

Then open <http://127.0.0.1:4173/>. The browser mode does not provide every desktop/native audio feature.

## Configuration

The app works without a configuration file. Optional development environment variables are documented in [.env.example](.env.example):

- `PORT`: local web-development port; defaults to `4173`.
- `NETEASE_API_BASE`: base URL of an external compatible provider; blank uses the embedded provider.
- `NETEASE_COOKIE`: development-only provider cookie. It is sensitive and must never be committed.

This project does not automatically load `.env`; set variables in the shell or use your own local environment loader. For example:

```powershell
$env:NETEASE_API_BASE="http://127.0.0.1:3000"
npm run dev:web
```

The packaged desktop app encrypts its provider cookie with the current Windows account and stores application state beside the portable executable in `CassettePilot Data`. Signing out deletes the stored provider credential.

## Music-service behavior

The pinned `@neteasecloudmusicapienhanced/api` package runs behind the loopback server. The application requests URLs authorized for the signed-in account and falls back through lower quality levels when needed. It does not enable the provider's cross-service unblock mode and sends streamed responses with `Cache-Control: no-store`.

The provider is unofficial and its upstream behavior, availability, and terms can change. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before distributing the app.

## Development and testing

Run the automated JavaScript tests and syntax checks:

```powershell
npm test
npm run check
```

Build and exercise the native codec/audio pipeline:

```powershell
npm run build:native
npm run test:native
```

The native verification generates temporary control-signal fixtures, checks JavaScript/native decoder parity, validates resampling and carrier detection, and tests reacquisition after a dropped capture block.

The optional Electron background-media smoke test needs an interactive Windows desktop/audio environment:

```powershell
npm run test:electron-background
```

## Packaging

Build the no-install Windows x64 executable:

```powershell
npm run dist
```

Output is written to `dist/`. Do not publish generated packages until you have reviewed their bundled dependency licenses, scanned them for credentials and unwanted local data, and recorded a SHA-256 checksum.

## Privacy and local data

- Login cookies are never stored in project files or exposed to browser code by the desktop app.
- Local settings, collections, logs, and calibration reports belong in the portable data directory and are excluded from Git.
- Streamed audio is proxied in memory and marked `no-store`; the project does not include music files.
- Uploaded calibration recordings and generated WAV files are excluded from Git.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations and [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## License

Original project code and the CassettePilot icon artwork are available under the [MIT License](LICENSE). Dependencies and service integrations remain subject to their own licenses and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
