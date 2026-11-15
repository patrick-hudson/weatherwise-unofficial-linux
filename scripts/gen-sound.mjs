// Generates assets/sounds/alert.wav: 3 short two-tone beeps (960/770 Hz), 16-bit mono 44.1 kHz.
// Usage: node scripts/gen-sound.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const AMP = 0.5;
const FADE = 0.01; // 10 ms fade in/out per tone

// Each beep: 960 Hz then 770 Hz, 0.18 s each; 0.14 s gap between beeps. Total ≈ 1.6 s.
const segments = [];
for (let i = 0; i < 3; i++) {
  segments.push({ f: 960, d: 0.18 }, { f: 770, d: 0.18 });
  segments.push({ f: 0, d: i < 2 ? 0.14 : 0.24 });
}

const samples = [];
for (const { f, d } of segments) {
  const n = Math.round(d * RATE);
  const fadeN = Math.round(FADE * RATE);
  for (let i = 0; i < n; i++) {
    if (f === 0) { samples.push(0); continue; }
    let env = 1;
    if (i < fadeN) env = i / fadeN;
    else if (i > n - fadeN) env = (n - i) / fadeN;
    samples.push(AMP * env * Math.sin((2 * Math.PI * f * i) / RATE));
  }
}

const dataLen = samples.length * 2;
const buf = Buffer.alloc(44 + dataLen);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataLen, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataLen, 40);
samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds', 'alert.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out} (${(samples.length / RATE).toFixed(2)} s)`);
