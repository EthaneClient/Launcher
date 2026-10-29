/**
 * Microsoft account sign-in for Minecraft: Java Edition.
 *
 *   Microsoft OAuth code  ->  Xbox Live token  ->  XSTS token  ->  Minecraft token  ->  profile
 *
 * The Microsoft page opens in a small window inside the launcher; the code comes back on
 * Microsoft's own "desktop" redirect page, which the window watches for and closes on.
 * The refresh token is kept (encrypted, see accounts.js) so later launches sign in silently.
 */
const { BrowserWindow } = require('electron');
const Http = require('./http');

// The public client id Minecraft's own launcher registered for desktop sign-in.
const CLIENT_ID = '00000000402b5328';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';

const XBOX_ERRORS = {
  2148916233: "This Microsoft account doesn't have an Xbox profile yet. Sign in once at minecraft.net, then try again.",
  2148916235: "Xbox Live isn't available in your country, so this account can't sign in.",
  2148916236: 'This account needs adult verification on xbox.com before it can sign in.',
  2148916237: 'This account needs adult verification on xbox.com before it can sign in.',
  2148916238: 'This is a child account. An adult has to add it to a Microsoft family before it can play.',
};

class SignInError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Opens the Microsoft sign-in page and resolves with the auth code (null if the window was closed). */
function promptForCode(parent) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 500,
      height: 680,
      parent,
      modal: !!parent,
      title: 'Sign in with Microsoft',
      backgroundColor: '#04060c',
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:microsoft', nodeIntegration: false, contextIsolation: true },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
      if (!win.isDestroyed()) win.close();
    };
    const check = url => {
      if (!url.startsWith(REDIRECT_URI)) return;
      const params = new URL(url).searchParams;
      if (params.get('code')) finish(resolve, params.get('code'));
      else if (params.get('error')) {
        const denied = params.get('error') === 'access_denied';
        finish(denied ? resolve : reject, denied ? null
          : new SignInError(params.get('error_description') || 'Microsoft sign-in failed.'));
      }
    };
    win.webContents.on('will-redirect', (_e, url) => check(url));
    win.webContents.on('will-navigate', (_e, url) => check(url));
    win.webContents.on('did-navigate', (_e, url) => check(url));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { if (!settled) { settled = true; resolve(null); } });

    const url = 'https://login.live.com/oauth20_authorize.srf?' + new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
      prompt: 'select_account',
    });
    win.loadURL(url);
  });
}

async function msToken(fields) {
  try {
    return await Http.postForm('https://login.live.com/oauth20_token.srf', {
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE, ...fields,
    });
  } catch (err) {
    if (err.status === 400) throw new SignInError('Your Microsoft sign-in expired. Please sign in again.', 'EXPIRED');
    throw err;
  }
}

/** Microsoft access token -> Minecraft access token + profile. */
async function minecraftFromMicrosoft(msAccessToken) {
  const xbl = await Http.postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: msAccessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });

  let xsts;
  try {
    xsts = await Http.postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (err) {
    let xerr = null;
    try { xerr = JSON.parse(err.body).XErr; } catch (e) { /* not JSON */ }
    if (xerr && XBOX_ERRORS[xerr]) throw new SignInError(XBOX_ERRORS[xerr]);
    throw err;
  }
  const uhs = xsts.DisplayClaims.xui[0].uhs;
  const xuid = xbl.DisplayClaims && xbl.DisplayClaims.xui && xbl.DisplayClaims.xui[0] ? xbl.DisplayClaims.xui[0].xid || '' : '';

  const mc = await Http.postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  });

  let profile;
  try {
    profile = await Http.getJson('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${mc.access_token}` },
    });
  } catch (err) {
    if (err.status === 404) {
      throw new SignInError("This Microsoft account doesn't own Minecraft: Java Edition. You can still play offline.", 'NO_GAME');
    }
    throw err;
  }

  return {
    uuid: profile.id,
    name: profile.name,
    xuid,
    accessToken: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
  };
}

/** Interactive sign-in. Resolves null if the player closed the window. */
async function signIn(parent) {
  const code = await promptForCode(parent);
  if (!code) return null;
  const ms = await msToken({ grant_type: 'authorization_code', code });
  return { ...(await minecraftFromMicrosoft(ms.access_token)), refreshToken: ms.refresh_token };
}

/** Silent sign-in from a saved refresh token. */
async function refresh(refreshToken) {
  const ms = await msToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return { ...(await minecraftFromMicrosoft(ms.access_token)), refreshToken: ms.refresh_token || refreshToken };
}

module.exports = { signIn, refresh, SignInError };
