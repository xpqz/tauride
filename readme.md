# Tauride

Tauride is an unofficial fork of [Dyalog Ride](https://github.com/Dyalog/ride), a cross-platform IDE for local and remote [Dyalog APL](https://www.dyalog.com) interpreters. The desktop app uses Tauri 2. A separate browser-only bundle can be served by Dyalog as zero-footprint Ride.

See the [release notes](docs/release-notes.md) for changes since the Ride fork.

![Screenshot](/screenshot.png?raw=true)

## Install

Download an installer from the [Tauride releases](https://github.com/xpqz/tauride/releases/latest): a DMG for Apple silicon Macs, an EXE or MSI for Windows x64, or a DEB, RPM or AppImage for Linux x64. See [installation instructions](docs/installation.md).

## Develop

Install Git, Node.js 22 or later, Rust stable and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/xpqz/tauride.git
cd tauride
npm ci
npm start
```

The pinned Tauri CLI is installed by `npm ci`. `npm start` and `npm run dev` stage the frontend and run the desktop development app. `npm run build` builds the release app for the current host. To produce an installer, pass the bundle configuration and the host's format, for example on macOS:

```sh
npm run build -- --config src-tauri/tauri.bundle.conf.json --bundles dmg
```

`npm run css` compiles styles. `npm run clean` removes generated frontend output. The browser bundle is built separately with `npm run build:zf`; the archive unpacks as `RIDEapp/` for an interpreter installation.

## Test

```sh
npm run test:unit
npm test
```

The native suite builds its own test app and needs Dyalog on PATH or `RIDE_TEST_DYALOG`, plus an unlocked desktop for native input. See [native UI testing](docs/ui-testing.md) and the [architecture and development guide](tauri/README.md).

The upstream [Ride documentation](https://dyalog.github.io/ride) describes shared interpreter and editor features. Tauride-specific installation, builds and native integrations are documented in this repository.
