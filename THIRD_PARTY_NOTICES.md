# Third-Party Notices

The repository's MIT license applies to the original project code. Dependencies remain under their own licenses and copyright notices. `package-lock.json` and the .NET project file pin the dependency versions used for release 0.1.0.

Notable direct dependencies include:

- `@neteasecloudmusicapienhanced/api` 4.39.0 — MIT; copyright notice in the installed package identifies Binaryify (2013–2022).
- Electron 43.3.0 — MIT.
- electron-builder 26.15.3 — MIT.
- NAudio 2.3.0 — MIT.

The npm dependency tree also includes `@unblockneteasemusic/server` 0.28.0 under LGPL-3.0-only through `@neteasecloudmusicapienhanced/unblockmusic-utils`. CassettePilot does not request the provider's unblock mode, but distributors must still preserve that component's LGPL notices and corresponding source rights. The installed npm package includes `COPYING` and `COPYING.LESSER`; do not remove them from redistributed dependency bundles. Packaging excludes that dependency's example proxy certificates and private key because this application does not use its certificate-proxy mode.

Other transitive packages use MIT, ISC, BSD, Apache-2.0, Blue Oak, Python-2.0, 0BSD, WTFPL, CC0, and dual-license expressions recorded in `package-lock.json`. Distributors are responsible for retaining the license material shipped with those packages.

NetEase Cloud Music names and marks belong to their respective owners. This project is independent and is not endorsed by or affiliated with NetEase. The API integration may be subject to separate service terms and local law.
