const fs = require('fs');
const os = require('os');
const Paths = require('./paths');

/** Half the machine's memory, between 2 and 6 GB, in 512 MB steps. */
function defaultRam() {
  const half = os.totalmem() / 1024 / 1024 / 2;
  return Math.max(2048, Math.min(6144, Math.floor(half / 512) * 512));
}

const DEFAULTS = {
  ramMb: defaultRam(),
  // Hide the launcher while the game runs; it comes back when the game closes.
  hideOnLaunch: true,
  jvmArgs: '',
  checkLauncherUpdates: true,
};

function maxRam() {
  return Math.max(2048, Math.floor(os.totalmem() / 1024 / 1024 / 512) * 512 - 1024);
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(Paths.settingsPath, 'utf8')); } catch (e) { /* first run */ }
  return { ...DEFAULTS, ...saved };
}

function save(changes) {
  const next = { ...load() };
  if ('ramMb' in changes) next.ramMb = Math.max(1024, Math.min(maxRam(), Math.round(Number(changes.ramMb) / 512) * 512 || DEFAULTS.ramMb));
  if ('hideOnLaunch' in changes) next.hideOnLaunch = !!changes.hideOnLaunch;
  if ('checkLauncherUpdates' in changes) next.checkLauncherUpdates = !!changes.checkLauncherUpdates;
  if ('jvmArgs' in changes) next.jvmArgs = String(changes.jvmArgs || '').slice(0, 1000);
  Paths.ensureDirectories();
  fs.writeFileSync(Paths.settingsPath, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, maxRam };
