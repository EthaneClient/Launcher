/**
 * Starts Minecraft from the launch manifest instance.js wrote. The JVM and game arguments
 * are Mojang's own (plus Fabric's), with the ${placeholders} filled in here, so the game
 * starts exactly the way the official launcher would start it.
 *
 * Events: 'booting', 'started' (the window is about to appear), 'crashed' (died while
 * starting), 'stopped' (closed after running), 'error' (could not be started at all).
 */
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const Config = require('./config');
const Paths = require('./paths');
const { windowedExe } = require('./java');

// The game counts as started once it logs one of these, or after this long without dying.
const STARTED_PATTERNS = [/Setting user:/, /Backend library:/, /OpenAL initialized/];
const BOOT_GRACE_MS = 25000;

/** Mojang's crash reports name the file; point the player straight at it. */
function crashReportFrom(output) {
  const m = output.match(/#@!@# Game crashed! Crash report saved to: #@!@# (.+)/) || output.match(/Crash report saved to:? (.+\.txt)/);
  return m ? m[1].trim() : null;
}

class Game extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this._killed = false;
  }

  get isRunning() { return !!this.process; }

  /**
   * @param {object} manifest   from Instance.prepare()
   * @param {object} account    { name, uuid, accessToken, xuid, type }
   * @param {object} settings   { ramMb, jvmArgs }
   */
  launch(manifest, account, settings = {}) {
    if (this.process) throw new Error('Ethane is already running.');
    this._killed = false;

    const sep = process.platform === 'win32' ? ';' : ':';
    const vars = {
      natives_directory: Paths.nativesDir,
      launcher_name: 'ethane-launcher',
      launcher_version: Config.VERSION,
      classpath: manifest.classpath.join(sep),
      classpath_separator: sep,
      library_directory: Paths.librariesDir,
      auth_player_name: account.name,
      version_name: manifest.mcVersion,
      game_directory: Paths.gameDir,
      assets_root: Paths.assetsDir,
      assets_index_name: manifest.assetIndex,
      auth_uuid: account.uuid.replace(/-/g, ''),
      auth_access_token: account.accessToken || '0',
      clientid: '',
      auth_xuid: account.xuid || '',
      user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
      version_type: manifest.versionType || 'release',
    };
    const fill = arg => arg.replace(/\$\{(\w+)\}/g, (all, key) => (key in vars ? vars[key] : all));

    const ramMb = Math.max(1024, Number(settings.ramMb) || 4096);
    const extraJvm = String(settings.jvmArgs || '').split(/\s+/).filter(a => a.startsWith('-'));
    const args = [
      `-Xms${Math.min(1024, ramMb)}m`,
      `-Xmx${ramMb}m`,
      ...extraJvm,
      ...manifest.jvmArgs.map(fill),
      manifest.mainClass,
      ...manifest.gameArgs.map(fill),
    ];
    // Empty optional values (no xuid / client id offline) would leave a flag with nothing after it.
    for (let i = args.length - 2; i >= 0; i--) {
      if (args[i].startsWith('--') && args[i + 1] === '') args.splice(i, 2);
    }

    fs.mkdirSync(Paths.nativesDir, { recursive: true });
    fs.mkdirSync(Paths.logsDir, { recursive: true });
    const log = fs.createWriteStream(Paths.gameLogPath, { flags: 'w' });
    const shown = args.map(a => (a === vars.auth_access_token && a.length > 8 ? '<token>' : a));
    log.write(`=== Ethane ${new Date().toISOString()} ===\nJava: ${manifest.javaExe}\nArgs: ${shown.join(' ')}\n\n`);

    const child = spawn(windowedExe(manifest.javaExe), args, {
      cwd: Paths.gameDir,
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;
    this.emit('booting', { pid: child.pid });

    let started = false;
    let tail = '';
    const markStarted = () => {
      if (started || this.process !== child) return;
      started = true;
      clearTimeout(grace);
      this.emit('started', { pid: child.pid });
    };
    const grace = setTimeout(markStarted, BOOT_GRACE_MS);
    const onData = chunk => {
      const text = chunk.toString();
      log.write(chunk);
      tail = (tail + text).slice(-8000);
      if (!started && STARTED_PATTERNS.some(p => p.test(text))) markStarted();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', err => {
      clearTimeout(grace);
      log.end(`\n[launcher] could not start Java: ${err.message}\n`);
      this.process = null;
      this.emit('error', new Error(`Java could not be started (${err.message}). Try Repair in Settings.`));
    });

    child.on('close', code => {
      clearTimeout(grace);
      log.end(`\n[launcher] game exited with code ${code}\n`);
      this.process = null;
      if (this._killed) { this.emit('stopped', { code, killed: true }); return; }
      const crash = crashReportFrom(tail);
      if (code !== 0 && (!started || crash)) {
        this.emit('crashed', {
          code,
          crashReport: crash,
          logPath: Paths.gameLogPath,
          message: started ? 'Minecraft crashed.' : 'Minecraft closed while starting.',
        });
        return;
      }
      this.emit('stopped', { code });
    });

    return child;
  }

  kill() {
    if (!this.process) return;
    this._killed = true;
    try { this.process.kill(); } catch (e) { /* already gone */ }
  }
}

module.exports = Game;
