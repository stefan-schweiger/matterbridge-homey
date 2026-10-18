/**
 * pack-tarball.mjs
 * Version: 1.1.0
 *
 * Builds the production tarball of the plugin, ready to upload in the Matterbridge frontend
 * (Plugins > Install > Upload) or to install with `npm install -g <tarball> --omit=dev`.
 *
 * Unlike `npm run npmPack`, it doesn't need git or a global Matterbridge and leaves node_modules and the lock file alone:
 *   1. builds the production dist in the project
 *   2. stages the package in a temporary directory with a package.json without devDependencies, scripts and automator
 *   3. writes an npm-shrinkwrap.json from the project lock file, so the tested dependency versions are installed
 *   4. packs it into the project root and rebuilds the development dist
 *
 * Development builds are marked private: when Matterbridge finds a plugin missing at start (e.g. in a recreated Docker
 * container), it reinstalls a private plugin from the last uploaded tarball, and any other from npm.
 *
 * Usage:
 *   node scripts/pack-tarball.mjs            Version <version>-dev-<yyyymmdd>-<HHMM>, so every upload is recognizable
 *   node scripts/pack-tarball.mjs --release  Version from package.json
 */

/* oxlint-disable no-console */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const isRelease = process.argv.includes('--release');

/**
 * Run an npm command and stop on failure.
 *
 * @param {string[]} args The npm arguments.
 * @param {string} cwd The working directory.
 */
function npm(args, cwd) {
  console.log(`> npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const now = new Date();
const pad = (value) => String(value).padStart(2, '0');
const version = isRelease ? pkg.version : `${pkg.version}-dev-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

npm(['run', 'cleanBuildProduction'], root);

const stage = mkdtempSync(path.join(os.tmpdir(), `${pkg.name}-pack-`));
try {
  // The files listed in package.json "files", plus the files npm always packs.
  for (const file of ['dist', 'CHANGELOG.md', 'README.md', 'LICENSE', `${pkg.name}.config.json`, `${pkg.name}.schema.json`, 'package-lock.json']) {
    if (existsSync(path.join(root, file))) cpSync(path.join(root, file), path.join(stage, file), { recursive: true });
  }
  const production = { ...pkg, version };
  delete production.devDependencies;
  delete production.scripts;
  delete production.automator;
  // npm has no development builds, so Matterbridge must reinstall them from the uploaded tarball.
  if (!isRelease) production.private = true;
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(production, null, 2)}\n`);

  // Prune the dev dependencies from the copied lock file and turn it into a shrinkwrap.
  npm(['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  npm(['shrinkwrap'], stage);
  npm(['pack', '--pack-destination', root], stage);
} finally {
  rmSync(stage, { recursive: true, force: true });
  npm(['run', 'build'], root);
}

console.log(`\nCreated ${path.join(root, `${pkg.name}-${version}.tgz`)}`);
