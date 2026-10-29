/**
 * Java 21 for Minecraft 1.21.11. Nothing is bundled with the launcher: it is downloaded once
 * from Adoptium into .ethane/runtime/java-21, so players never have to install Java themselves.
 * A Java 21 the player already has (JAVA_HOME or PATH) is used instead when there is one.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const Paths = require('./paths');
const Http = require('./http');
const { extractArchive } = require('./archive');
const { JAVA_MAJOR } = require('./config');

// Adoptium's "latest GA release" redirect: always the newest Java 21 build for this OS/arch.
const ADOPTIUM_ARCH = { x64: 'x64', arm64: 'aarch64' }[process.arch] || 'x64';
const ADOPTIUM_OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const ADOPTIUM_URL =
  `https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/${ADOPTIUM_OS}/${ADOPTIUM_ARCH}/jre/hotspot/normal/eclipse?project=jdk`;

function testJava(exePath) {
  if (!exePath) return null;
  try {
    const res = spawnSync(exePath, ['-version'], { timeout: 6000, windowsHide: true, encoding: 'utf8' });
    const output = (res.stderr || '') + (res.stdout || '');
    const m = output.match(/version "(\d+)/);
    if (m && Number(m[1]) === JAVA_MAJOR) return { exe: exePath, output: output.trim() };
  } catch (e) { /* not runnable */ }
  return null;
}

function binIn(home) {
  return path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

/** Adoptium's archive unpacks one level deep (jdk-21.0.x+y-jre/), and on macOS under Contents/Home. */
function homesUnder(dir) {
  const homes = [dir];
  if (!fs.existsSync(dir)) return homes;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    homes.push(path.join(dir, entry.name), path.join(dir, entry.name, 'Contents', 'Home'));
  }
  return homes;
}

/** The managed copy first, then the player's own Java 21. */
function findJava() {
  for (const home of homesUnder(Paths.javaDir)) {
    if (!fs.existsSync(binIn(home))) continue;
    const found = testJava(binIn(home));
    if (found) return found;
  }
  if (process.env.JAVA_HOME) {
    const fromEnv = testJava(binIn(process.env.JAVA_HOME));
    if (fromEnv) return fromEnv;
  }
  return testJava(process.platform === 'win32' ? 'java.exe' : 'java');
}

/**
 * On Windows the game runs under javaw.exe, which has no console window. Same folder,
 * same version, so it only swaps the file name.
 */
function windowedExe(javaExe) {
  if (process.platform !== 'win32') return javaExe;
  const javaw = path.join(path.dirname(javaExe), 'javaw.exe');
  return path.isAbsolute(javaExe) && fs.existsSync(javaw) ? javaw : javaExe;
}

async function ensureJava(report = () => {}, isCancelled = () => false) {
  const existing = findJava();
  if (existing) {
    report(1, `Java ${JAVA_MAJOR} ready`);
    return existing;
  }

  report(0, `Downloading Java ${JAVA_MAJOR}...`);
  fs.rmSync(Paths.javaDir, { recursive: true, force: true });
  fs.mkdirSync(Paths.javaDir, { recursive: true });
  fs.mkdirSync(Paths.cacheDir, { recursive: true });

  const archive = path.join(Paths.cacheDir, `java-${JAVA_MAJOR}.archive`);
  try {
    await Http.download(ADOPTIUM_URL, archive, {
      isCancelled,
      stallMs: 60000,
      onProgress: (d, t) => { if (t > 0) report(0.9 * d / t, `Downloading Java ${JAVA_MAJOR}...`); },
    });
    report(0.9, `Unpacking Java ${JAVA_MAJOR}...`);
    if (!await extractArchive(archive, Paths.javaDir, 180000)) {
      throw new Error(`Could not unpack the Java ${JAVA_MAJOR} download.`);
    }
  } finally {
    fs.rmSync(archive, { force: true });
  }

  const found = findJava();
  if (!found) throw new Error(`Java ${JAVA_MAJOR} was downloaded but would not start. Try Repair in Settings.`);
  report(1, `Java ${JAVA_MAJOR} ready`);
  return found;
}

module.exports = { ensureJava, findJava, windowedExe };
