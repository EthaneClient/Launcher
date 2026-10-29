/**
 * HTTP helpers shared by every part of the launcher that talks to the network.
 *
 *   getJson / postJson / postForm   small requests
 *   download                        streams a file to disk with progress, cancel, retry and an
 *                                   atomic finish: bytes land in "<dest>.part" and are renamed
 *                                   into place only once complete, so an interrupted run can
 *                                   never leave a truncated file where a real one belongs.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { VERSION } = require('./config');

const USER_AGENT = `EthaneLauncher/${VERSION}`;

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.code = 'CANCELLED';
  }
}

class HttpStatusError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.body = body;
  }
}

function open(urlStr, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  const parsed = new URL(urlStr);
  const client = parsed.protocol === 'https:' ? https : http;
  const allHeaders = { 'User-Agent': USER_AGENT, ...headers };
  if (body != null) allHeaders['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: allHeaders,
      timeout,
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** Follows redirects (GET only); resolves with the final response stream. */
async function openFollow(urlStr, options, maxRedirects = 6) {
  let url = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await open(url, options);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (!options || !options.body)) {
      res.resume();
      url = new URL(res.headers.location, url).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

async function request(url, options = {}) {
  const res = await openFollow(url, options);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
}

async function requestJson(url, options) {
  const res = await request(url, options);
  const text = res.body.toString('utf8');
  if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, url, text);
  return text ? JSON.parse(text) : null;
}

const getJson = (url, options = {}) =>
  requestJson(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });

const postJson = (url, data, options = {}) => requestJson(url, {
  ...options,
  method: 'POST',
  body: JSON.stringify(data),
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
});

const postForm = (url, fields, options = {}) => requestJson(url, {
  ...options,
  method: 'POST',
  body: new URLSearchParams(fields).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...options.headers },
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadOnce(url, dest, { onProgress, isCancelled, headers, stallMs }) {
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(part, { force: true });

  const res = await openFollow(url, { headers, timeout: stallMs });
  if (res.statusCode !== 200) {
    res.resume();
    throw new HttpStatusError(res.statusCode, url);
  }

  const total = parseInt(res.headers['content-length'] || '0', 10);
  let received = 0;
  const out = fs.createWriteStream(part);

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => { if (!settled) { settled = true; reject(err); } };
      const timer = setInterval(() => {
        if (isCancelled && isCancelled()) {
          res.destroy();
          fail(new CancelledError());
        }
      }, 200);

      res.setTimeout(stallMs, () => res.destroy(new Error('Download stalled')));
      res.on('data', chunk => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('Connection closed early')));
      out.on('error', fail);
      out.on('finish', () => { clearInterval(timer); if (!settled) { settled = true; resolve(); } });
      res.on('end', () => clearInterval(timer));
      res.pipe(out);
    });
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }

  if (total > 0 && received !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`Download incomplete (${received} of ${total} bytes)`);
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
}

/**
 * @param {string} url
 * @param {string} dest final file path
 * @param {{onProgress?:(received:number,total:number)=>void, isCancelled?:()=>boolean,
 *          headers?:object, retries?:number, stallMs?:number}} [options]
 */
async function download(url, dest, options = {}) {
  const { retries = 2, stallMs = 30000, isCancelled } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (isCancelled && isCancelled()) throw new CancelledError();
    try {
      await downloadOnce(url, dest, { ...options, stallMs });
      return;
    } catch (err) {
      lastError = err;
      // Cancelled by the user, or the server said no: another attempt will not change that.
      if (err.code === 'CANCELLED' || (err.status && err.status >= 400 && err.status < 500)) throw err;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError;
}

module.exports = { request, getJson, postJson, postForm, download, CancelledError, HttpStatusError, USER_AGENT };
