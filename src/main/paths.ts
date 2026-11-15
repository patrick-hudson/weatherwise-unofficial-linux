import { app } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';

const home = os.homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

export const APP_ID = 'weatherwise-linux';
export const SITE_URL = 'https://web.weatherwise.app/';
export const SITE_ORIGIN = 'https://web.weatherwise.app';

export const configDir = path.join(xdgConfig, APP_ID);
export const dataDir = path.join(xdgData, APP_ID);
export const configFile = path.join(configDir, 'config.json');
export const windowStateFile = path.join(dataDir, 'window-state.json');
export const alertStateFile = path.join(dataDir, 'alerts-state.json');
export const sessionFile = path.join(dataDir, 'session.json');
export const locationCacheFile = path.join(dataDir, 'last-location.json');

/** Root of the packaged/unpacked app (contains dist/, assets/). */
export const appRoot = app.getAppPath();
// assets/ is unpacked from the asar so external programs (pw-play, the
// notification daemon) can read the sound and icon files.
export const assetsDir = path.join(appRoot.replace(/app\.asar$/, 'app.asar.unpacked'), 'assets');
export const rendererDir = path.join(appRoot, 'dist', 'renderer');
export const preloadDir = path.join(appRoot, 'dist', 'preload');

export const iconPath = path.join(assetsDir, 'icons', 'icon.png');
export const trayIconPath = path.join(assetsDir, 'icons', 'tray.png');
export const trayAlertIconPath = path.join(assetsDir, 'icons', 'tray-alert.png');
export const alertSoundPath = path.join(assetsDir, 'sounds', 'alert.wav');
