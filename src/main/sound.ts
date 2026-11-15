import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const PLAYERS = ['pw-play', 'paplay', 'aplay'];
const DEBOUNCE_MS = 5000;
let lastPlay = 0;

function tryPlayer(index: number, file: string): void {
  if (index >= PLAYERS.length) return;
  let moved = false;
  const next = () => {
    if (moved) return;
    moved = true;
    tryPlayer(index + 1, file);
  };
  try {
    const child = spawn(PLAYERS[index], [file], { detached: true, stdio: 'ignore' });
    // ENOENT (player not installed) → try the next one.
    child.on('error', next);
    // Non-zero exit (e.g. no PipeWire server) → try the next one.
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) next();
    });
    child.unref();
  } catch {
    next();
  }
}

/** Play a sound file with pw-play → paplay → aplay. Never throws. At most once per 5 s. */
export function playSound(file: string): void {
  try {
    const now = Date.now();
    if (now - lastPlay < DEBOUNCE_MS) return;
    if (!file || !fs.existsSync(file)) return;
    lastPlay = now;
    tryPlayer(0, file);
  } catch {
    /* ignore */
  }
}
