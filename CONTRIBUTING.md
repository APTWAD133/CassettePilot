# Contributing

Thanks for helping improve CassettePilot.

## Before opening a change

- Use an issue or discussion to coordinate substantial features and behavior changes.
- Do not include credentials, cookies, account data, copyrighted recordings, or generated build output.
- Only contribute code and assets you have the right to license under this repository's MIT license.
- Keep third-party copyright notices and license files intact.

## Development workflow

Requirements are Node.js 20 or newer, the .NET 8 SDK, Windows, and a Windows x64 machine for the native audio host.

```powershell
npm ci
npm run build:native
npm test
npm run check
npm run test:native
```

The Electron background smoke test exercises Windows media behavior and may need an interactive desktop/audio session:

```powershell
npm run test:electron-background
```

Build the portable package with:

```powershell
npm run dist
```

## Pull requests

Explain the user-facing effect, list the checks you ran, and call out any untested Windows audio hardware paths. Add or update tests for behavior changes. Keep each pull request focused and avoid unrelated formatting churn.

By submitting a contribution, you agree that it may be distributed under the repository's MIT license and confirm that you have the right to submit it.
