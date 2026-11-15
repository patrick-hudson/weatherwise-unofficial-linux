#!/usr/bin/env node
// Cuts a CalVer release: YYYY.M.N (N counts releases within the month, from 0).
// The version stays valid semver so electron-updater can compare versions.
//
//   npm run release            # bump, commit, tag v<version>, push → CI builds + publishes
//   npm run release -- --dry-run
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry-run');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (cmd, args) => (dry ? console.log(`[dry-run] ${cmd} ${args.join(' ')}`) : execFileSync(cmd, args, { stdio: 'inherit' }));

if (git('status', '--porcelain')) {
  console.error('Working tree has uncommitted changes; commit or stash them first.');
  process.exit(1);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') {
  console.error(`Releases are cut from main (you're on ${branch}).`);
  process.exit(1);
}

run('git', ['pull', '--ff-only', '--tags']);
const now = new Date();
const prefix = `${now.getFullYear()}.${now.getMonth() + 1}.`;
const used = git('tag', '--list', `v${prefix}*`)
  .split('\n')
  .filter(Boolean)
  .map((t) => Number(t.slice(1 + prefix.length)))
  .filter(Number.isInteger);
const version = `${prefix}${used.length ? Math.max(...used) + 1 : 0}`;

console.log(`Releasing v${version}`);
const current = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { encoding: 'utf8' })).version;
if (current !== version) {
  run('npm', ['version', version, '--no-git-tag-version']);
  run('git', ['commit', '-am', `Release v${version}`]);
}
run('git', ['tag', '-a', `v${version}`, '-m', `WeatherWise for Linux ${version}`]);
run('git', ['push', 'origin', 'main', `v${version}`]);
console.log(dry ? 'Dry run done.' : `Pushed v${version}; GitHub Actions is building the release.`);
