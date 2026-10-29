const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const Config = require('./backend/config');
const Paths = require('./backend/paths');
const Http = require('./backend/http');
const Settings = require('./backend/settings');
const { Instance } = require('./backend/instance');
const { Accounts } = require('./backend/accounts');
const Game = require('./backend/game');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Paths.ensureDirectories();

  const instance = new Instance();
  const game = new Game();
  let accounts = null; // safeStorage needs the app to be ready
  let win = null;
  let tray = null;
  const ICON = path.join(__dirname, 'assets', 'img', process.platform === 'win32' ? 'ethane.ico' : 'icon.png');

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  app.on('second-instance', () => showWindow());

  // ── window ───────────────────────────────────────────────────────────────────

  function createWindow() {
    win = new BrowserWindow({
      width: 1040,
      height: 640,
      minWidth: 900,
      minHeight: 580,
      frame: false,
      show: false,
      backgroundColor: '#04060c',
      icon: ICON,
      title: Config.PRODUCT,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('maximize', () => send('win:maximized', true));
    win.on('unmaximize', () => send('win:maximized', false));
    // The page is local; links go to the browser (through shell:open), never into this window.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
  }

  function showWindow() {
    if (tray) { tray.destroy(); tray = null; }
    if (!win || win.isDestroyed()) return;
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  function hideToTray() {
    if (!win || win.isDestroyed()) return;
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(ICON));
      tray.setToolTip('Ethane is running');
      tray.on('click', showWindow);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show Ethane Launcher', click: showWindow },
        { label: 'Quit launcher', click: () => app.quit() },
      ]));
    }
    win.hide();
  }

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize', () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on('win:close', () => win && win.close());

  // ── game events ──────────────────────────────────────────────────────────────

  let hideTimer = null;
  game.on('booting', () => send('launch:progress', { progress: 1, message: 'Starting Minecraft...' }));
  game.on('started', () => {
    send('launch:started');
    // Leave "Running" on screen a moment so the hand-off doesn't look like a crash.
    if (Settings.load().hideOnLaunch) hideTimer = setTimeout(hideToTray, 1800);
  });
  game.on('stopped', () => {
    clearTimeout(hideTimer);
    showWindow();
    send('launch:stopped');
  });
  game.on('crashed', info => {
    clearTimeout(hideTimer);
    showWindow();
    send('launch:crashed', info);
  });
  game.on('error', err => {
    clearTimeout(hideTimer);
    showWindow();
    send('launch:error', { error: err.message });
  });

  // ── launching ────────────────────────────────────────────────────────────────

  ipcMain.handle('game:launch', async (_e, options = {}) => {
    if (game.isRunning) return { ok: false, error: 'Ethane is already running.' };
    if (instance.isInstalling) return { ok: false, error: 'Ethane is already being set up.' };

    let manifest;
    try {
      manifest = await instance.prepare(p => send('launch:progress', { progress: p.progress * 0.94, message: p.message }));
    } catch (err) {
      if (err.code === 'CANCELLED') return { ok: true, cancelled: true };
      return { ok: false, error: err.message };
    }

    let creds;
    try {
      send('launch:progress', { progress: 0.96, message: 'Starting Minecraft...' });
      creds = await accounts.credentialsForLaunch({ offline: !!options.offline });
    } catch (err) {
      return { ok: false, error: err.message, code: err.code === 'EXPIRED' ? 'RELOGIN' : undefined };
    }

    try {
      game.launch(manifest, creds, Settings.load());
      return { ok: true, ethane: manifest.ethane };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('game:cancel', () => {
    instance.cancel();
    game.kill();
    return { ok: true };
  });

  ipcMain.handle('game:repair', async () => {
    if (game.isRunning || instance.isInstalling) return { ok: false, error: 'Close the game first.' };
    instance.resetForRepair();
    try {
      await instance.prepare(p => send('launch:progress', p));
      return { ok: true };
    } catch (err) {
      if (err.code === 'CANCELLED') return { ok: true, cancelled: true };
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('game:status', () => ({
    installed: instance.isInstalled(),
    running: game.isRunning,
    installing: instance.isInstalling,
  }));

  /** Upload time of the newest Ethane.jar, for the "build" line. */
  ipcMain.handle('ethane:release', async () => {
    const release = instance.release || await instance.fetchRelease();
    const jar = release && (release.assets || []).find(a => a.name === 'Ethane.jar');
    return jar ? { builtAt: jar.updated_at, size: jar.size } : null;
  });

  // ── accounts & settings ──────────────────────────────────────────────────────

  ipcMain.handle('player:get', () => accounts.publicInfo());
  ipcMain.handle('player:set-name', (_e, name) => {
    try { return { ok: true, ...accounts.setName(name) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('player:link-microsoft', async () => {
    try {
      const res = await accounts.linkMicrosoft(win);
      return res ? { ok: true, ...res } : { ok: false, cancelled: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('player:unlink-microsoft', () => ({ ok: true, ...accounts.unlinkMicrosoft() }));

  ipcMain.handle('settings:get', () => ({ ...Settings.load(), maxRam: Settings.maxRam() }));
  ipcMain.handle('settings:save', (_e, changes) => ({ ...Settings.save(changes || {}), maxRam: Settings.maxRam() }));

  // ── app info, updates, shell ─────────────────────────────────────────────────

  ipcMain.handle('app:info', () => ({
    version: Config.VERSION,
    mcVersion: Config.MC_VERSION,
    dataDir: Paths.baseDir,
    platform: process.platform,
  }));

  /** A newer launcher on the EthaneLauncher releases page, or null. */
  ipcMain.handle('app:update-check', async () => {
    if (!Settings.load().checkLauncherUpdates) return null;
    try {
      const rel = await Http.getJson(Config.LAUNCHER_RELEASES_API, { timeout: 10000 });
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      const newer = (a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
        return false;
      };
      return /^\d+(\.\d+)*$/.test(latest) && newer(latest, Config.VERSION) ? { version: latest, url: rel.html_url } : null;
    } catch (e) {
      return null;
    }
  });

  const FOLDERS = {
    game: () => Paths.gameDir,
    mods: () => Paths.modsDir,
    screenshots: () => path.join(Paths.gameDir, 'screenshots'),
    logs: () => Paths.logsDir,
  };
  ipcMain.handle('shell:open-folder', (_e, which) => {
    const dir = (FOLDERS[which] || FOLDERS.game)();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
  ipcMain.handle('shell:open-file', (_e, file) => {
    // Only files the launcher itself pointed at: the game log or a crash report in the game folder.
    const resolved = path.resolve(String(file || ''));
    if (resolved === path.resolve(Paths.gameLogPath) || resolved.startsWith(path.resolve(Paths.gameDir) + path.sep)) {
      shell.openPath(resolved);
    }
  });
  ipcMain.handle('shell:open-external', (_e, url) => {
    try {
      const u = new URL(url);
      const okHost = ['github.com', 'ethaneclient.github.io', 'discord.gg', 'discord.com', 'www.minecraft.net'].includes(u.hostname);
      if (u.protocol === 'https:' && okHost) shell.openExternal(u.toString());
    } catch (e) { /* ignore bad URLs */ }
  });

  app.whenReady().then(() => {
    accounts = new Accounts();
    createWindow();
  });

  app.on('window-all-closed', () => {
    // Closing the launcher never kills a running game.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (tray) tray.destroy();
    if (instance.isInstalling) instance.cancel();
  });

  process.on('uncaughtException', err => {
    console.error(err);
    dialog.showErrorBox(Config.PRODUCT, err && err.stack ? err.stack : String(err));
  });
}
