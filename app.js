(() => {
  const $ = id => document.getElementById(id);
  const api = window.ethane;

  // Same module list as the website ticker.
  const MODULES = ['KillAura', 'Velocity', 'Reach', 'Criticals', 'Backtrack', 'Tick Base', 'Fake Lag', 'Super Knockback',
    'AutoPot', 'Speed', 'Flight', 'Scaffold', 'No Slow', 'Keep Sprint', 'InventoryMove', 'Spiderman', 'V-Clip', 'No Web',
    'Click GUI', 'Array List', 'Target HUD', 'ESP', 'Fullbright', 'Zoom', 'Animations', 'Trail', 'No Fall', 'BedNuker',
    'Inventory Manager', 'Auto Tool', 'Blink', 'Timer', 'Anti Fireball', 'Disabler', 'Anti Cheat Sniffer', 'Crystal Optimizer'];
  const shuffled = [...MODULES].sort(() => Math.random() - 0.5);
  const strip = list => list.map(n => `<span>${n}</span>`).join('');
  $('tickA').innerHTML = strip(shuffled).repeat(2);
  $('tickB').innerHTML = strip([...shuffled].reverse()).repeat(2);

  // ── window & tabs ──────────────────────────────────────────────────────────────

  $('wMin').onclick = api.win.minimize;
  $('wMax').onclick = api.win.maximize;
  $('wClose').onclick = api.win.close;

  function showView(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === `view-${name}`));
  }
  document.querySelectorAll('.tab').forEach(t => { t.onclick = () => showView(t.dataset.view); });

  document.querySelectorAll('[data-href]').forEach(b => { b.onclick = () => api.shell.openExternal(b.dataset.href); });
  document.querySelectorAll('[data-folder]').forEach(b => { b.onclick = () => api.shell.openFolder(b.dataset.folder); });

  // ── toast ──────────────────────────────────────────────────────────────────────

  let toastTimer = null;
  function toast(message, actions = [], kind = 'error') {
    clearTimeout(toastTimer);
    $('toastMsg').textContent = message;
    $('toast').className = kind === 'info' ? 'toast info' : 'toast';
    const acts = $('toastActs');
    acts.innerHTML = '';
    for (const [label, fn] of [...actions, ['Dismiss', null]]) {
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = label;
      b.onclick = () => { $('toast').hidden = true; if (fn) fn(); };
      acts.appendChild(b);
    }
    $('toast').hidden = false;
    if (kind === 'info') toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
  }

  // ── player ─────────────────────────────────────────────────────────────────────

  let player = null;
  function renderPlayer(p) {
    player = p;
    const ms = p.microsoft;
    const name = $('name');
    name.value = ms ? ms.name : p.name;
    name.readOnly = !!ms;
    name.title = ms ? 'Your linked Minecraft account' : 'Click to change your name';
    $('head').src = `https://mc-heads.net/avatar/${ms ? ms.uuid : 'MHF_Steve'}/52`;
    setNote(ms ? 'linked minecraft account' : 'click the name to change it');
    $('playerHelp').textContent = ms
      ? 'Online servers work. Unlink in Settings to play under a custom name.'
      : 'Works in singleplayer, LAN and cracked servers. For online servers like Hypixel, link your Minecraft account in Settings.';

    $('msLabel').textContent = ms ? `Unlink ${ms.name}` : 'Link Microsoft';
    $('msBtn').classList.toggle('linked', !!ms);
  }
  function setNote(text, kind = '') {
    $('nameNote').textContent = text;
    $('nameNote').className = kind;
  }
  $('head').onerror = () => { $('head').removeAttribute('src'); };

  async function saveName() {
    const input = $('name');
    if (input.readOnly || !player || input.value.trim() === player.name) return;
    const res = await api.player.setName(input.value);
    if (res.ok) {
      renderPlayer(res);
      setNote('saved', 'ok');
      setTimeout(() => setNote('click the name to change it'), 1500);
    } else {
      setNote(res.error, 'bad');
      input.focus();
    }
  }
  $('nameForm').onsubmit = e => { e.preventDefault(); $('name').blur(); };
  $('name').addEventListener('blur', saveName);
  $('name').addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('name').value = player.name; $('name').blur(); }
  });

  $('msBtn').onclick = async () => {
    if (player && player.microsoft) {
      renderPlayer(await api.player.unlinkMicrosoft());
      return;
    }
    $('msBtn').disabled = true;
    try {
      const res = await api.player.linkMicrosoft();
      if (res.ok) {
        renderPlayer(res);
        toast(`Linked ${res.microsoft.name}. Online servers will work now.`, [], 'info');
      } else if (!res.cancelled) {
        toast(res.error);
      }
    } finally {
      $('msBtn').disabled = false;
    }
  };

  // ── play ───────────────────────────────────────────────────────────────────────

  let state = 'idle'; // idle | busy | running
  function setState(next, label) {
    state = next;
    const btn = $('play');
    btn.classList.toggle('busy', next === 'busy');
    btn.classList.toggle('running', next === 'running');
    btn.disabled = next !== 'idle';
    $('playLabel').textContent = label || { idle: 'Play', busy: 'Setting up...', running: 'Running' }[next];
    $('progress').hidden = next !== 'busy';
    $('hint').hidden = next === 'busy';
    $('repair').disabled = next !== 'idle';
    if (next === 'busy') setProgress(0, 'Getting ready...');
  }
  function setProgress(fraction, message) {
    $('progressBar').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    if (message) $('progressMsg').textContent = message;
  }

  async function launch(options = {}) {
    if (state !== 'idle') return;
    setState('busy');
    const res = await api.game.launch(options);
    if (res.ok && res.cancelled) { setState('idle'); return; }
    if (!res.ok) {
      setState('idle');
      if (res.code === 'RELOGIN') {
        toast(res.error, [
          ['Play offline this time', () => launch({ offline: true })],
          ['Link again', () => { showView('settings'); $('msBtn').click(); }],
        ]);
      } else {
        toast(res.error, [['Try again', () => launch(options)]]);
      }
      return;
    }
    if (res.ethane && res.ethane.updated) toast('Ethane was updated to the newest build.', [], 'info');
  }
  $('play').onclick = () => launch();
  $('cancel').onclick = () => api.game.cancel();

  api.game.onProgress(p => { if (state === 'busy') setProgress(p.progress, p.message); });
  api.game.onStarted(() => setState('running'));
  api.game.onStopped(() => setState('idle'));
  api.game.onError(p => { setState('idle'); toast(p.error); });
  api.game.onCrashed(info => {
    setState('idle');
    const acts = [];
    if (info.crashReport) acts.push(['Open crash report', () => api.shell.openFile(info.crashReport)]);
    acts.push(['Open log', () => api.shell.openFile(info.logPath)]);
    toast(`${info.message} If it keeps happening, send the log in the Discord.`, acts);
  });

  // ── settings ───────────────────────────────────────────────────────────────────

  const gb = mb => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;
  function renderSettings(s) {
    $('ram').max = s.maxRam;
    $('ram').value = s.ramMb;
    $('ramOut').textContent = gb(s.ramMb);
    $('hideOnLaunch').classList.toggle('on', s.hideOnLaunch);
    $('checkUpdates').classList.toggle('on', s.checkLauncherUpdates);
    if (document.activeElement !== $('jvmArgs')) $('jvmArgs').value = s.jvmArgs;
  }
  const save = async changes => renderSettings(await api.settings.save(changes));
  $('ram').oninput = () => { $('ramOut').textContent = gb(Number($('ram').value)); };
  $('ram').onchange = () => save({ ramMb: Number($('ram').value) });
  $('hideOnLaunch').onclick = () => save({ hideOnLaunch: !$('hideOnLaunch').classList.contains('on') });
  $('checkUpdates').onclick = () => save({ checkLauncherUpdates: !$('checkUpdates').classList.contains('on') });
  $('jvmArgs').onchange = () => save({ jvmArgs: $('jvmArgs').value });
  $('logs').onclick = () => api.shell.openFolder('logs');

  $('repair').onclick = async () => {
    if (state !== 'idle') return;
    showView('play');
    setState('busy');
    const res = await api.game.repair();
    setState('idle');
    if (res.ok && !res.cancelled) toast('Repaired. Everything is up to date.', [], 'info');
    else if (!res.ok) toast(res.error);
  };

  // ── startup ────────────────────────────────────────────────────────────────────

  (async () => {
    const [info, p, s, status] = await Promise.all([api.app.info(), api.player.get(), api.settings.get(), api.game.status()]);
    $('aboutVer').textContent = `v${info.version}`;
    $('dataDir').textContent = info.dataDir;
    renderPlayer(p);
    renderSettings(s);
    if (status.running) setState('running');
    if (status.installed) $('hint').textContent = 'Every launch checks for the newest Ethane build first.';

    api.game.release().then(rel => {
      if (!rel) return;
      const date = new Date(rel.builtAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      $('buildLine').textContent = `fabric ${info.mcVersion}  /  ethane build ${date}  /  free & open source`;
    });
    api.app.updateCheck().then(upd => {
      if (!upd) return;
      $('updVer').textContent = `v${upd.version}`;
      $('updGo').onclick = () => api.shell.openExternal(upd.url);
      $('update').hidden = false;
    });
  })();
})();
