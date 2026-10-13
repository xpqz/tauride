# Installation

Tauride is an unofficial fork of Ride with a [Tauri 2](https://tauri.app) desktop shell. Install it separately from Dyalog's official Ride. Download packages from the [Tauride releases page](https://github.com/xpqz/tauride/releases).

The desktop installers contain the IDE; install Dyalog separately to start a local interpreter, or connect to a remote interpreter. Dyalog 15.0 or later is required. Connection settings and preferences retain their existing `Ride-4.8` storage location.

## macOS

Download the Apple silicon **.dmg**, open it and drag **Tauride** into **Applications**. These releases are ad-hoc signed rather than notarized. If macOS blocks the app, use its **Privacy & Security** settings to allow the downloaded app after verifying its source.

## Windows

Download the Windows x64 **.exe** (NSIS) or **.msi** installer and follow its prompts. Tauride uses Microsoft Edge WebView2; see the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) for runtime requirements.

## Linux

Download the Linux x64 **.deb**, **.rpm** or **.AppImage** appropriate for your distribution. Install DEB and RPM packages using the distribution's package manager so it resolves dependencies. For AppImage, make the downloaded file executable before opening it.

Tauride uses WebKitGTK 4.1. The Linux packages are built on Ubuntu 24.04; the older Electron Ride platform requirements do not describe these packages. See the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) when building from source.

## Font and keyboard support

Tauride bundles its APL font for use within the IDE. System-wide APL fonts and keyboard layouts are configured separately; see [APL Fonts and Keyboards](https://www.dyalog.com/apl-font-keyboard.htm). Tauride's prefix input and custom keyboard mappings remain available within the application.

## Ride in the browser

The separately published `tauride-zf-*.zip` contains the browser frontend, laid out as `RIDEapp/`. It is intended for an interpreter installation that serves zero-footprint Ride, rather than installation alongside the desktop app. See the [browser build instructions](https://github.com/xpqz/tauride/blob/main/tauri/README.md#zero-footprint-ride) and [Ride in the browser](ride_in_the_browser.md).

## Configuration (.ini) File

A **.ini** configuration file can be used to define settings for the `RIDE_INIT` configuration parameter. By default, the interpreter will look for a **ride.ini** file in:

-  the directory in which the default session and log files are stored, for example, **C:\Users\JohnDoe\AppData\Local\Programs\Dyalog** (on Microsoft Windows)
- **$HOME/.dyalog** (on all other platforms)

This file is not automatically created by Dyalog but can be created manually. Examples of the fields that you might want to include within the **.ini** configuration file are included in the [sample configuration file](sample_configuration_file.md).

A different name and location for the .ini configuration file can be specified by including a second `mode`, `CONFIG`, in the [RIDE_INIT](ridespecific_language_features.md/#ride_init) parameter and setting it so that `CONFIG=<filename>`, where `<filename>` is the fully-qualified path to, and name of, a **.ini** configuration file containing name-value pairs related to mode, certificate details, and so on.

!!!note
    The **.ini** configuration file must be located on the machine on which the interpreter is running (this is not necessarily the same machine as the one on which Ride is running).
