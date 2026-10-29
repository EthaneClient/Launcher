/**
 * Runnable app:  npm run build   (or build.bat)
 *
 *   node scripts/build.js                 -> build/Ethane Launcher.exe (+ the Electron runtime next to it)
 *   node scripts/build.js --out=<folder>  write somewhere else (make-installer.js does)
 *
 * Only what the launcher needs at runtime is staged (no node_modules, no dev tooling).
 * Scratch work happens in .build-tmp/, which is deleted when the build ends.
 */
const fs = require('fs');
const path = require('path');
const packager = require('electron-packager');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT = path.resolve(ROOT, outArg ? outArg.slice(6) : 'build');
const WORK = path.join(ROOT, '.build-tmp');
const STAGE = path.join(WORK, 'app');
const PACK = path.join(WORK, 'pack');
const PRODUCT = pkg.productName;

const RUNTIME_FILES = ['main.js', 'preload.js', 'app.js', 'index.html', 'styles.css'];
const RUNTIME_DIRS = ['backend', 'assets'];

function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
  }
  return total;
}

async function build() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  console.log('[1/3] Staging runtime files');
  for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(ROOT, file), path.join(STAGE, file));
  for (const dir of RUNTIME_DIRS) fs.cpSync(path.join(ROOT, dir), path.join(STAGE, dir), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
    name: pkg.name, productName: PRODUCT, version: pkg.version, description: pkg.description,
    main: pkg.main, author: pkg.author, license: pkg.license,
  }, null, 2));

  console.log('[2/3] Packaging with Electron');
  const [packed] = await packager({
    dir: STAGE,
    out: PACK,
    name: PRODUCT,
    platform: 'win32',
    arch: 'x64',
    electronVersion: require('electron/package.json').version,
    icon: path.join(ROOT, 'assets', 'img', 'ethane.ico'),
    appVersion: pkg.version,
    appCopyright: `Copyright (c) ${new Date().getFullYear()} ${pkg.author}`,
    win32metadata: {
      CompanyName: pkg.author,
      FileDescription: PRODUCT,
      ProductName: PRODUCT,
      OriginalFilename: `${PRODUCT}.exe`,
    },
    asar: true,
    prune: false,
    overwrite: true,
    quiet: true,
  });

  // Chromium only needs one locale pack to run; the other ~50 are dead weight.
  const locales = path.join(packed, 'locales');
  for (const file of fs.readdirSync(locales)) if (file !== 'en-US.pak') fs.rmSync(path.join(locales, file));

  console.log(`[3/3] Writing ${path.relative(ROOT, OUT) || OUT}/`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.renameSync(packed, OUT);
  console.log(`\nDone. ${path.join(OUT, `${PRODUCT}.exe`)}  (${(folderSize(OUT) / 1048576).toFixed(0)} MB)`);
}

build()
  .catch(err => {
    console.error('\nBuild failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(WORK, { recursive: true, force: true }));
