'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', {
  dsh: {
    onState: (callback) => subscribe('dsh:state', callback),
    retry: () => ipcRenderer.invoke('dsh:retry'),
    installRequirements: (request) => ipcRenderer.invoke('dsh:install-requirements', request),
    openLogs: () => ipcRenderer.invoke('dsh:open-logs'),
    copyDiagnostics: () => ipcRenderer.invoke('dsh:copy-diagnostics'),
  },
});
