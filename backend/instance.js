/**
 * Installs and repairs the Minecraft 1.21.11 + Fabric instance Ethane runs in, so a player
 * never has to run the Fabric installer or find a mods folder.
 *
 *   1. Java 21            downloaded once (java.js)
 *   2. vanilla game files  client jar, libraries, asset objects, from Mojang's version JSON
 *   3. Fabric Loader      newest stable loader for 1.21.11, from Fabric's meta API
 *   4. mods               Ethane.jar and the Fabric API it was built against, both from the
 *                         Ethane "JAR" release, re-downloaded whenever a new upload appears
 *
 * Everything already on disk is checked and skipped, so after the first run a launch is a
 * few quick requests. With no internet at all, an instance that was installed before still
 * starts from the saved launch manifest.
 *
 * Natives: since 1.19 Mojang lists LWJGL's native jars as ordinary libraries (Windows x64,
 * arm64 and x86 all under the same "windows" rule) and LWJGL picks the right one from the
 * classpath at runtime. They are NOT unpacked into one folder here, because the three
 * Windows builds share file names and would overwrite each other.
 */
const path = require('path');
const fs = require('fs');

const Config = require('./config');
const Paths = require('./paths');
const Http = require('./http');
const { isValidZip } = require('./archive');
const { ensureJava } = require('./java');

const { MC_VERSION } = Config;
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ASSET_HOST = 'https://resources.download.minecraft.net/';
const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader/';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/';
const ETHANE_JAR = 'Ethane.jar';

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const OS_ARCH = process.arch === 'ia32' ? 'x86' : process.arch;

/** Mojang's rule format: the last matching rule wins; rules that need launcher "features" never match. */
function rulesAllow(rules) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    const os = rule.os || {};
    const matches = !rule.features
      && (!os.name || os.name === OS_NAME)
      && (!os.arch || os.arch === OS_ARCH);
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** "group:artifact:version[:classifier]" -> its path in a maven repo. */
function mavenPath(name) {
  const [group, artifact, version, classifier] = name.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/** Identity of a library regardless of version, so Fabric's newer ASM replaces any older one. */
function libraryKey(name) {
  const [group, artifact, , classifier] = name.split(':');
  return `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;
}

/** Flattens Mojang/Fabric "arguments" lists (strings, or {rules, value}) for this machine. */
function flattenArgs(list) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') out.push(item);
    else if (item && rulesAllow(item.rules)) out.push(...[].concat(item.value));
  }
  return out;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

class Instance {
  constructor() {
    this.isInstalling = false;
    this._cancelled = false;
    this.release = null; // last read of the Ethane "JAR" release
  }

  cancel() { this._cancelled = true; }
  _check() { if (this._cancelled) throw new Http.CancelledError(); }

  get clientJar() { return path.join(Paths.versionsDir, MC_VERSION, `${MC_VERSION}.jar`); }

  isInstalled() {
    const manifest = readJson(Paths.launchManifestPath);
    return !!(manifest && manifest.mcVersion === MC_VERSION && isValidZip(this.clientJar, 1_000_000)
      && isValidZip(path.join(Paths.modsDir, ETHANE_JAR), 1024));
  }

  /** Forgets the install so the next prepare() checks and re-fetches everything. Keeps worlds, settings and the player's own mods. */
  resetForRepair() {
    fs.rmSync(Paths.launchManifestPath, { force: true });
    fs.rmSync(Paths.modStatePath, { force: true });
    fs.rmSync(path.join(Paths.versionsDir, MC_VERSION), { recursive: true, force: true });
    fs.rmSync(Paths.librariesDir, { recursive: true, force: true });
    fs.rmSync(path.join(Paths.modsDir, ETHANE_JAR), { force: true });
  }

  /**
   * Gets everything into a launchable state and returns the launch manifest:
   * { javaExe, mainClass, classpath[], jvmArgs[], gameArgs[], assetIndex, mcVersion, ethane }.
   */
  async prepare(report = () => {}) {
    if (this.isInstalling) throw new Error('Ethane is already being set up.');
    this.isInstalling = true;
    this._cancelled = false;
    const slice = (from, to) => (fraction, message) =>
      report({ progress: from + (to - from) * Math.max(0, Math.min(1, fraction)), message });

    try {
      Paths.ensureDirectories();

      const java = await ensureJava(slice(0, 0.12), () => this._cancelled);
      this._check();

      let manifest;
      try {
        manifest = await this._installGame(slice(0.12, 0.85));
      } catch (err) {
        if (err.code === 'CANCELLED') throw err;
        // No internet (or Mojang/Fabric down): a complete earlier install still runs.
        const cached = readJson(Paths.launchManifestPath);
        if (!cached || cached.mcVersion !== MC_VERSION || !isValidZip(this.clientJar, 1_000_000)) {
          throw new Error(`Could not download Minecraft ${MC_VERSION}. Check your internet connection and try again. (${err.message})`);
        }
        console.warn('Install check failed, using the saved install:', err.message);
        manifest = cached;
      }
      this._check();

      manifest.ethane = await this._ensureMods(slice(0.85, 1));
      manifest.javaExe = java.exe;
      writeJson(Paths.launchManifestPath, manifest);

      report({ progress: 1, message: 'Ready' });
      return manifest;
    } finally {
      this.isInstalling = false;
    }
  }

  // ── Minecraft + Fabric ─────────────────────────────────────────────────────────

  async _installGame(report) {
    report(0, `Checking Minecraft ${MC_VERSION}...`);
    const versionList = await Http.getJson(MOJANG_MANIFEST);
    const entry = (versionList.versions || []).find(v => v.id === MC_VERSION);
    if (!entry) throw new Error(`Minecraft ${MC_VERSION} is not on Mojang's version list.`);
    const version = await Http.getJson(entry.url);
    writeJson(path.join(Paths.versionsDir, MC_VERSION, `${MC_VERSION}.json`), version);

    report(0.02, 'Checking Fabric Loader...');
    const fabric = await this._fabricProfile();
    this._check();

    // Client jar
    const client = version.downloads && version.downloads.client;
    if (!client) throw new Error(`Mojang did not list a client download for ${MC_VERSION}.`);
    if (!this._fileOk(this.clientJar, client.size, 5_000_000)) {
      await Http.download(client.url, this.clientJar, {
        isCancelled: () => this._cancelled,
        onProgress: (d, t) => { if (t > 0) report(0.03 + 0.12 * d / t, `Downloading Minecraft ${MC_VERSION}...`); },
      });
      if (!isValidZip(this.clientJar, 5_000_000)) throw new Error(`The Minecraft ${MC_VERSION} download was incomplete.`);
    }
    this._check();

    // Libraries: Fabric's take precedence over vanilla's copy of the same artifact.
    const libs = new Map();
    for (const lib of fabric.libraries || []) libs.set(libraryKey(lib.name), lib);
    for (const lib of version.libraries || []) {
      if (!rulesAllow(lib.rules)) continue;
      const key = libraryKey(lib.name);
      if (!libs.has(key)) libs.set(key, lib);
    }
    const classpath = await this._ensureLibraries([...libs.values()], (f, m) => report(0.15 + 0.2 * f, m));
    classpath.push(this.clientJar);
    this._check();

    // Assets
    const assetIndex = version.assetIndex;
    const indexFile = path.join(Paths.assetsDir, 'indexes', `${assetIndex.id}.json`);
    if (!this._fileOk(indexFile, assetIndex.size, 1)) {
      await Http.download(assetIndex.url, indexFile, { isCancelled: () => this._cancelled });
    }
    await this._ensureAssets(indexFile, (f, m) => report(0.35 + 0.65 * f, m));

    return {
      mcVersion: MC_VERSION,
      fabricLoader: fabric.loaderVersion,
      mainClass: fabric.mainClass,
      classpath,
      jvmArgs: [...flattenArgs(version.arguments && version.arguments.jvm),
        ...flattenArgs(fabric.arguments && fabric.arguments.jvm)],
      gameArgs: [...flattenArgs(version.arguments && version.arguments.game),
        ...flattenArgs(fabric.arguments && fabric.arguments.game)],
      assetIndex: assetIndex.id,
      versionType: version.type || 'release',
    };
  }

  /** Newest stable Fabric Loader for this game version (Fabric lists newest first). */
  async _fabricProfile() {
    const loaders = await Http.getJson(`${FABRIC_META}${MC_VERSION}`);
    const pick = (loaders || []).find(l => l.loader && l.loader.stable) || (loaders || [])[0];
    if (!pick) throw new Error(`Fabric has no loader for Minecraft ${MC_VERSION} yet.`);
    const loaderVersion = pick.loader.version;
    const profile = await Http.getJson(`${FABRIC_META}${MC_VERSION}/${loaderVersion}/profile/json`);
    if (!profile || !profile.mainClass) throw new Error('Fabric returned an unusable loader profile.');
    return { ...profile, loaderVersion };
  }

  _fileOk(file, expectedSize, minSize) {
    try {
      const size = fs.statSync(file).size;
      return expectedSize ? size === expectedSize : size >= minSize;
    } catch (e) {
      return false;
    }
  }

  /** Downloads what's missing (a few at a time) and returns the classpath in list order. */
  async _ensureLibraries(libraries, report) {
    const jobs = libraries.map(lib => {
      const artifact = lib.downloads && lib.downloads.artifact;
      const rel = (artifact && artifact.path) || mavenPath(lib.name);
      return {
        name: lib.name,
        dest: path.join(Paths.librariesDir, ...rel.split('/')),
        url: (artifact && artifact.url) || `${(lib.url || FABRIC_MAVEN).replace(/\/+$/, '')}/${rel}`,
        size: artifact && artifact.size,
      };
    });
    const missing = jobs.filter(j => !this._fileOk(j.dest, j.size, 128));
    let done = 0;
    await this._pool(missing, 6, async job => {
      await Http.download(job.url, job.dest, { isCancelled: () => this._cancelled, retries: 3 });
      done++;
      report(done / missing.length, `Downloading libraries (${done}/${missing.length})...`);
    });
    const broken = jobs.filter(j => !this._fileOk(j.dest, j.size, 128));
    if (broken.length) throw new Error(`Could not download ${broken[0].name}.`);
    report(1, 'Libraries ready');
    return jobs.map(j => j.dest);
  }

  async _ensureAssets(indexFile, report) {
    const index = readJson(indexFile);
    if (!index) throw new Error('The game asset index could not be read.');
    const objects = new Map();
    for (const obj of Object.values(index.objects || {})) {
      if (obj && /^[0-9a-f]{40}$/.test(obj.hash)) objects.set(obj.hash, obj.size);
    }
    const objectPath = h => path.join(Paths.assetsDir, 'objects', h.slice(0, 2), h);
    const missing = [...objects].filter(([h, size]) => !this._fileOk(objectPath(h), size, 0));
    if (missing.length === 0) { report(1, 'Game assets ready'); return; }

    let done = 0, failed = 0;
    const ticker = setInterval(() => report(done / missing.length, `Downloading game assets (${done}/${missing.length})...`), 200);
    try {
      await this._pool(missing, 12, async ([h]) => {
        try {
          await Http.download(`${ASSET_HOST}${h.slice(0, 2)}/${h}`, objectPath(h), { retries: 3, isCancelled: () => this._cancelled });
        } catch (e) {
          if (e.code === 'CANCELLED') throw e;
          failed++;
        }
        done++;
      });
    } finally {
      clearInterval(ticker);
    }
    // A handful of missing sounds won't stop the game; they're retried next launch.
    if (failed > missing.length * 0.05) throw new Error(`${failed} game assets failed to download.`);
  }

  async _pool(items, size, fn) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        this._check();
        await fn(items[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
    this._check();
  }

  // ── Ethane + Fabric API ────────────────────────────────────────────────────────

  /** The Ethane "JAR" release, or null if GitHub can't be reached right now. */
  async fetchRelease() {
    try {
      this.release = await Http.getJson(Config.ETHANE_RELEASE_API, { timeout: 12000 });
    } catch (e) {
      console.warn('Ethane release check failed:', e.message);
    }
    return this.release;
  }

  async _ensureMods(report) {
    report(0, 'Checking for Ethane updates...');
    fs.mkdirSync(Paths.modsDir, { recursive: true });
    const release = await this.fetchRelease();
    const assets = (release && release.assets) || [];
    const state = readJson(Paths.modStatePath, {});
    const stamp = a => `${a.updated_at}|${a.size}`;

    // Ethane.jar
    const ethaneAsset = assets.find(a => a.name === ETHANE_JAR);
    const ethaneDest = path.join(Paths.modsDir, ETHANE_JAR);
    const haveEthane = isValidZip(ethaneDest, 1024);
    let updated = false;
    if (!haveEthane || (ethaneAsset && state.ethane !== stamp(ethaneAsset))) {
      await Http.download(ethaneAsset ? ethaneAsset.browser_download_url : Config.ETHANE_JAR_URL, ethaneDest, {
        isCancelled: () => this._cancelled,
        onProgress: (d, t) => { if (t > 0) report(0.05 + 0.6 * d / t, haveEthane ? 'Updating Ethane...' : 'Downloading Ethane...'); },
      });
      if (!isValidZip(ethaneDest, 1024)) {
        fs.rmSync(ethaneDest, { force: true });
        throw new Error('The Ethane download was incomplete. Please try again.');
      }
      updated = haveEthane;
      state.ethane = ethaneAsset ? stamp(ethaneAsset) : null;
    }
    // Old copies under other names (Ethane-1.0.jar, ethane (1).jar...) would load twice.
    for (const name of fs.readdirSync(Paths.modsDir)) {
      if (/^ethane.*\.jar$/i.test(name) && name !== ETHANE_JAR) fs.rmSync(path.join(Paths.modsDir, name), { force: true });
    }
    this._check();

    // Fabric API: the build attached to the release, else keep whatever is there, else a known-good one.
    const apiAsset = assets.find(a => /^fabric-api-.+\.jar$/.test(a.name));
    const apiJars = () => fs.readdirSync(Paths.modsDir).filter(n => /^fabric-api-.+\.jar$/.test(n));
    if (apiAsset || apiJars().length === 0) {
      const url = apiAsset ? apiAsset.browser_download_url : Config.FABRIC_API_FALLBACK_URL;
      const dest = path.join(Paths.modsDir, apiAsset ? apiAsset.name : path.basename(new URL(url).pathname).replace(/%2B/gi, '+'));
      if (!isValidZip(dest, 1024)) {
        await Http.download(url, dest, {
          isCancelled: () => this._cancelled,
          onProgress: (d, t) => { if (t > 0) report(0.7 + 0.3 * d / t, 'Downloading Fabric API...'); },
        });
        if (!isValidZip(dest, 1024)) {
          fs.rmSync(dest, { force: true });
          throw new Error('The Fabric API download was incomplete. Please try again.');
        }
      }
      for (const name of apiJars()) if (name !== path.basename(dest)) fs.rmSync(path.join(Paths.modsDir, name), { force: true });
    }

    writeJson(Paths.modStatePath, state);
    report(1, 'Ethane ready');
    return { updated, builtAt: ethaneAsset ? ethaneAsset.updated_at : null };
  }
}

module.exports = { Instance, rulesAllow, mavenPath, libraryKey, flattenArgs };
