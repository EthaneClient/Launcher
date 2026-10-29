/**
 * Who the game starts as. There's no Ethane account: the player just has a name (one is
 * picked on first run, and they can change it), which works in singleplayer, LAN and
 * offline-mode servers.
 *
 * Optionally they can link their Minecraft (Microsoft) account in Settings, which online-mode
 * servers like Hypixel require. When linked, the game starts as that account instead.
 * Its tokens are encrypted with the OS keychain (Electron safeStorage) before touching disk.
 */
const fs = require('fs');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const Paths = require('./paths');
const Microsoft = require('./microsoft');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function seal(text) {
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
  return 'raw:' + Buffer.from(text, 'utf8').toString('base64');
}

function unseal(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch (e) { /* keychain changed: the player links again */ }
  return '';
}

/** The UUID Minecraft itself gives an offline player: UUID v3 of "OfflinePlayer:<name>". */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

class Accounts {
  constructor() {
    try { this.data = JSON.parse(fs.readFileSync(Paths.accountsPath, 'utf8')); } catch (e) { this.data = {}; }
    if (!NAME_RE.test(this.data.name || '')) {
      this.data.name = `Ethane${crypto.randomInt(1000, 10000)}`;
      this._save();
    }
  }

  _save() {
    Paths.ensureDirectories();
    fs.writeFileSync(Paths.accountsPath, JSON.stringify(this.data, null, 2));
  }

  /** What the window may see: no tokens. */
  publicInfo() {
    const ms = this.data.microsoft;
    return {
      name: this.data.name,
      offlineUuid: offlineUuid(this.data.name),
      microsoft: ms ? { name: ms.name, uuid: ms.uuid } : null,
    };
  }

  setName(rawName) {
    const name = String(rawName || '').trim();
    if (!NAME_RE.test(name)) throw new Error('Names are 3 to 16 letters, numbers or underscores.');
    this.data.name = name;
    this._save();
    return this.publicInfo();
  }

  /** Opens Microsoft's sign-in window. Returns null if the player closed it. */
  async linkMicrosoft(parent) {
    const res = await Microsoft.signIn(parent);
    if (!res) return null;
    this._storeMicrosoft(res);
    return this.publicInfo();
  }

  unlinkMicrosoft() {
    delete this.data.microsoft;
    this._save();
    return this.publicInfo();
  }

  _storeMicrosoft(res) {
    this.data.microsoft = {
      name: res.name,
      uuid: res.uuid,
      xuid: res.xuid,
      refreshToken: seal(res.refreshToken),
      accessToken: seal(res.accessToken),
      expiresAt: res.expiresAt,
    };
    this._save();
  }

  /**
   * What the game starts as. With a linked Microsoft account, refreshes its token when it's
   * within 10 minutes of expiring. `offline` skips the linked account for this one launch.
   */
  async credentialsForLaunch({ offline = false } = {}) {
    const ms = this.data.microsoft;
    if (!ms || offline) {
      return { type: 'offline', name: this.data.name, uuid: offlineUuid(this.data.name), accessToken: '0' };
    }
    let accessToken = unseal(ms.accessToken);
    if (!accessToken || !ms.expiresAt || ms.expiresAt - Date.now() < 10 * 60 * 1000) {
      const refreshToken = unseal(ms.refreshToken);
      if (!refreshToken) throw new Microsoft.SignInError('Your Minecraft account needs to be linked again.', 'EXPIRED');
      const res = await Microsoft.refresh(refreshToken);
      this._storeMicrosoft(res);
      accessToken = res.accessToken;
    }
    const now = this.data.microsoft;
    return { type: 'microsoft', name: now.name, uuid: now.uuid, xuid: now.xuid, accessToken };
  }
}

module.exports = { Accounts, offlineUuid };
