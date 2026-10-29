// The only bridge between the window and the launcher: a fixed list of calls, no Node access.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const on = channel => fn => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('ethane', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    onMaximized: on('win:maximized'),
  },
  app: { info: invoke('app:info'), updateCheck: invoke('app:update-check') },
  game: {
    launch: invoke('game:launch'),
    cancel: invoke('game:cancel'),
    repair: invoke('game:repair'),
    status: invoke('game:status'),
    release: invoke('ethane:release'),
    onProgress: on('launch:progress'),
    onStarted: on('launch:started'),
    onStopped: on('launch:stopped'),
    onCrashed: on('launch:crashed'),
    onError: on('launch:error'),
  },
  player: {
    get: invoke('player:get'),
    setName: invoke('player:set-name'),
    linkMicrosoft: invoke('player:link-microsoft'),
    unlinkMicrosoft: invoke('player:unlink-microsoft'),
  },
  settings: { get: invoke('settings:get'), save: invoke('settings:save') },
  shell: {
    openFolder: invoke('shell:open-folder'),
    openFile: invoke('shell:open-file'),
    openExternal: invoke('shell:open-external'),
  },
});
