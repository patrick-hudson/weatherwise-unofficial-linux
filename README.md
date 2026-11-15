# WeatherWise for Linux (unofficial)

A desktop app for [WeatherWise](https://web.weatherwise.app/) on Linux, built
with Electron. It runs the live WeatherWise web app as a native **Wayland**
window and adds the things a browser tab can't do: severe-weather
notifications, a tray icon, and saved places that don't need an account.

> Not affiliated with WeatherWise. The WeatherWise name and icons belong to
> their owners and are fetched from the web app for personal use. Don't
> redistribute builds under their branding. WeatherWise Plus/Pro subscribers can
> use the [official desktop app](https://weatherwise.app) instead.

## Features

- **Native window**
  - Runs as a native Wayland window (Electron ≥ 38 picks Wayland on its own),
    with GPU-accelerated radar.
  - Custom title bar in WeatherWise colors, with Back, Forward, Reload, Places,
    Settings and an active-alert badge.
  - The window buttons follow your KDE layout (`kwinrc`).
- **Severe-weather notifications** from the National Weather Service
  (US only):
  - Covers your location plus any saved places.
  - Each alert notifies once, even across restarts.
  - Extreme and Severe alerts stay on screen until dismissed (critical urgency).
  - Notifications have **Open map** and **Details** buttons and play an alert
    sound.
  - Settings for minimum severity, quiet hours and event filters.
- **Saved places without an account**
  - Right-click the map → **Save Location**. If you're not logged in, the place
    is saved in the app.
  - Ctrl+D saves the current view.
  - The pin button in the title bar opens a saved place. Each one can also get
    alerts.
- **Your real location**: set it by searching your street address (exact) or a town, using the map center,
  or picking a saved place (📍 My location). The blue dot and alerts use it
  instead of the often-wrong system/IP location.
- **WeatherWise preferences in Settings**: dark mode, time format, data picker,
  popups, scale bar and units, projection, rotation and tilt, day/night shading,
  and POI labels. They're synced both ways with the site's own **My
  Preferences** and **Map Settings**, which you can also open from Settings.
- **Pop-out cameras**: traffic and hazard camera players get a **Pop out** button
  that moves the live stream into its own floating window (Picture-in-Picture).
  The in-app popup is tucked away until you close the floating window.
- **Remembers where you were**: the map reopens at the same position, zoom and
  layers.
- **Location without Google**: Chromium can't locate you on Linux, so the
  page's location requests go through your set location or geoclue.
- **Tray**
  - Keeps running in the background for alerts (configurable: ask / tray /
    quit).
  - Unloads the map after a while hidden to free memory, and refreshes stale
    radar when the window is shown again.
- **Links**
  - Captcha, checkout and hazcams stay in the app.
  - Everything else opens in your browser.
  - "Open WeatherWise link from clipboard" in the tray finishes password-reset
    links in the app.
- **Keyboard shortcuts**

  | Keys | Action |
  |---|---|
  | F5 / Ctrl+R | Reload |
  | Ctrl+Shift+R | Hard reload |
  | F11 | Fullscreen |
  | Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
  | Alt+←/→ | Back / forward |
  | Ctrl+D | Save the current view as a place |
  | Ctrl+, | Settings |
  | Ctrl+Q | Quit |

Settings live in `~/.config/weatherwise-linux/config.json`. Set
`WEATHERWISE_LINUX_HOME=/some/dir` to run a completely separate profile, e.g. for testing. App data (login
session, window state, alert history, last map view) lives in
`~/.local/share/weatherwise-linux/`.

## Build

Requirements (Fedora): `nodejs npm ImageMagick rpm-build libxcrypt-compat`.

```bash
npm ci
npm run fetch-assets   # downloads the official icons (also done automatically by build)
npm start              # build and run
npm run dist           # release/WeatherWise-<version>-x86_64.AppImage and .rpm
```

Run the AppImage directly (`chmod +x` it first), or integrate it with Gear
Lever or AppImageLauncher. The RPM installs to `/opt/WeatherWise` and adds a
menu entry.

## Security notes

- The site runs sandboxed with context isolation and no Node access. It can
  only call a few narrow IPC methods (location, share, save place), and each
  one checks the sender's origin.
- Electron fuses are on: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no
  inspector flags, asar integrity checks, and the app only loads from the
  asar.
- Dependencies are pinned and audited (`npm audit` reports 0
  vulnerabilities). The only runtime dependency is
  [`@particle/dbus-next`](https://www.npmjs.com/package/@particle/dbus-next),
  used for geoclue and notifications. Town search sends only the typed name to
  the Open-Meteo geocoding API.

## Releases and updates

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)),
so nothing needs to be built or signed locally. Versions are CalVer,
`YYYY.M.DHHMM` in UTC, e.g. `2026.11.142048` is Nov 14 at 20:48 UTC. The last part
is a unique release id, so you can publish as often as you like:

```bash
npm run release   # CalVer version YYYY.M.DHHMM, tags v<version>, pushes; CI builds + publishes
```

The workflow publishes `WeatherWise-<version>-x86_64.AppImage`, the `.rpm`,
and `latest-linux.yml` with blockmaps to a GitHub Release.

- **AppImage:** checks for a new release at startup and every 6 hours (or
  tray → *Check for Updates…*). It downloads only the changed blocks in the
  background and swaps itself in when you restart.
- **RPM:** tells you when a new version is out and links to the download.
