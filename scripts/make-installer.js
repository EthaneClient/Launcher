/**
 * Installer:  npm run release   (or build.bat)
 *
 * Builds the app (scripts/build.js), zips it, and compiles installer/Installer.cs twice with the
 * C# compiler that ships with Windows: once WITHOUT the payload (the uninstaller, embedded in
 * the installer), once WITH it. Result: release/EthaneLauncherSetup.exe, one file to hand out.
 * Then renders the installer's pages to release/preview/ so they can be checked without installing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.installer-tmp');
const RELEASE = path.join(ROOT, 'release');
const PRODUCT = pkg.productName;
// No spaces: GitHub renames spaced asset names, and the site links to releases/latest/download/EthaneLauncherSetup.exe.
const SETUP = 'EthaneLauncherSetup.exe';

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const REFS = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.IO.Compression.dll'];

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${what} failed`);
}

function csc(out, resources) {
  run(CSC, [
    '/nologo', '/target:winexe', '/optimize+', '/langversion:5',
    `/out:${out}`,
    `/win32icon:${path.join(ROOT, 'assets', 'img', 'ethane.ico')}`,
    ...REFS.map(r => `/r:${r}`),
    ...resources.map(([file, name]) => `/resource:${file},${name}`),
    path.join(ROOT, 'installer', 'Installer.cs'),
    path.join(TMP, 'Config.cs'),
  ], 'C# compile');
}

const mb = file => (fs.statSync(file).size / 1048576).toFixed(0);

function main() {
  if (process.platform !== 'win32' || !fs.existsSync(CSC)) throw new Error(`C# compiler not found at ${CSC}. The installer is built on Windows.`);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  console.log('[1/4] Building the app');
  const app = path.join(TMP, 'app');
  run(process.execPath, [path.join(__dirname, 'build.js'), `--out=${app}`], 'App build');

  console.log('[2/4] Compressing payload');
  const payload = path.join(TMP, 'payload.zip');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    `[IO.Compression.ZipFile]::CreateFromDirectory('${app}', '${payload}', [IO.Compression.CompressionLevel]::Optimal, $false)`],
  'Compression');

  fs.writeFileSync(path.join(TMP, 'Config.cs'), [
    'namespace EthaneSetup',
    '{',
    '    static class Config',
    '    {',
    `        public const string Product = "${PRODUCT}";`,
    `        public const string Version = "${pkg.version}";`,
    `        public const string Publisher = "${pkg.author}";`,
    `        public const string ExeName = "${PRODUCT}.exe";`,
    '    }',
    '}',
    '',
  ].join('\r\n'));

  console.log('[3/4] Compiling uninstaller and installer');
  const logo = [path.join(ROOT, 'assets', 'img', 'ethane.png'), 'logo.png'];
  const uninstall = path.join(TMP, 'uninstall.exe');
  csc(uninstall, [logo]);
  fs.mkdirSync(RELEASE, { recursive: true });
  const out = path.join(RELEASE, SETUP);
  fs.rmSync(out, { force: true });
  csc(out, [logo, [payload, 'payload.zip'], [uninstall, 'uninstall.exe']]);

  console.log('[4/4] Rendering installer pages to release/preview/');
  const preview = path.join(RELEASE, 'preview');
  fs.rmSync(preview, { recursive: true, force: true });
  spawnSync(out, [`/preview=${preview}`], { stdio: 'inherit', timeout: 30000 });

  console.log(`\n${out}  (${mb(out)} MB)`);
  console.log('Publish it by attaching it to a release of EthaneClient/EthaneLauncher; the tag (e.g. v1.0.1) is');
  console.log('what running launchers compare their version against. Bump "version" in package.json first.');
}

try {
  main();
} catch (err) {
  console.error('\nRelease failed:', err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
