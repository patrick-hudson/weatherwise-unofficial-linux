import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'weatherwise-linux.desktop');

/** The command that launches this app (AppImage path when run from an AppImage). */
function execPath(): string {
  return process.env.APPIMAGE || process.execPath;
}

export function setAutostart(enabled: boolean): void {
  try {
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exec = execPath().replace(/(["\\`$])/g, '\\$1');
    fs.writeFileSync(
      file,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=WeatherWise',
        'Comment=Severe weather radar and alerts',
        `Exec="${exec}" --hidden`,
        'Icon=weatherwise-linux',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        'X-KDE-autostart-after=panel',
        '',
      ].join('\n'),
    );
  } catch (e) {
    console.warn('[autostart] failed', e);
  }
}
