/**
 * Everything the launcher writes lives under one ".ethane" folder:
 *
 *   .ethane/
 *     instance/        the game folder: mods, saves, config, resourcepacks, screenshots, options.txt
 *     versions/        the vanilla 1.21.11 jar and version JSON
 *     libraries/       Minecraft + Fabric libraries
 *     assets/          sounds, languages, textures shared by the game
 *     runtime/java-21  the Java the launcher downloads, so users never install one themselves
 *     launcher/        settings, accounts, logs
 *
 * Windows: %APPDATA%\.ethane    macOS: ~/Library/Application Support/.ethane    Linux: ~/.ethane
 * Set ETHANE_HOME to use another folder (handy for testing).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

function getBaseDir() {
  if (process.env.ETHANE_HOME) return path.resolve(process.env.ETHANE_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.ethane');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', '.ethane');
  return path.join(os.homedir(), '.ethane');
}

const baseDir = getBaseDir();
const gameDir = path.join(baseDir, 'instance');
const launcherDir = path.join(baseDir, 'launcher');

const Paths = {
  baseDir,
  gameDir,
  modsDir: path.join(gameDir, 'mods'),
  nativesDir: path.join(gameDir, 'natives'),
  versionsDir: path.join(baseDir, 'versions'),
  librariesDir: path.join(baseDir, 'libraries'),
  assetsDir: path.join(baseDir, 'assets'),
  javaDir: path.join(baseDir, 'runtime', 'java-21'),
  cacheDir: path.join(baseDir, '.cache'),

  launcherDir,
  logsDir: path.join(launcherDir, 'logs'),
  settingsPath: path.join(launcherDir, 'settings.json'),
  accountsPath: path.join(launcherDir, 'accounts.json'),
  // What the last successful install resolved: main class, classpath, arguments. Lets the game
  // start with no internet once it has been installed.
  launchManifestPath: path.join(launcherDir, 'launch.json'),
  // Which Ethane.jar / Fabric API upload is in mods/.
  modStatePath: path.join(launcherDir, 'mods.json'),
  gameLogPath: path.join(launcherDir, 'logs', 'game.log'),

  appRoot: path.resolve(__dirname, '..'),

  ensureDirectories() {
    for (const dir of [this.baseDir, this.gameDir, this.modsDir, this.versionsDir, this.librariesDir,
      this.assetsDir, this.cacheDir, this.launcherDir, this.logsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  },
};

module.exports = Paths;
