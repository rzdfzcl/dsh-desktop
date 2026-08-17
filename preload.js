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
    checkEnvironment: () => ipcRenderer.invoke('dsh:check-environment'),
    restart: () => ipcRenderer.invoke('dsh:restart'),
  },
  sidebar: {
    getState: () => ipcRenderer.invoke('sidebar:get-state'),
    setOpen: (open) => ipcRenderer.invoke('sidebar:set-open', Boolean(open)),
    setWidth: (width) => ipcRenderer.invoke('sidebar:set-width', Number(width)),
    setTool: (tool, options) => ipcRenderer.invoke('sidebar:set-tool', tool, options),
    onState: (callback) => subscribe('sidebar:state', callback),
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    choose: () => ipcRenderer.invoke('workspace:choose'),
    listFiles: () => ipcRenderer.invoke('workspace:list-files'),
    readFile: (relativePath) => ipcRenderer.invoke('workspace:read-file', relativePath),
    onChanged: (callback) => subscribe('workspace:changed', callback),
  },
  review: {
    get: (source = 'auto') => ipcRenderer.invoke('review:get', source),
    getFileDiff: (source, relativePath) => ipcRenderer.invoke('review:get-file-diff', source, relativePath),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    add: (packageSpec) => ipcRenderer.invoke('plugins:add', packageSpec),
    remove: (packageName) => ipcRenderer.invoke('plugins:remove', packageName),
  },
  terminal: {
    run: (command) => ipcRenderer.invoke('terminal:run', command),
    onOutput: (callback) => subscribe('terminal:output', callback),
  },
  browser: {
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    action: (action) => ipcRenderer.invoke('browser:action', action),
    onState: (callback) => subscribe('browser:state', callback),
  },
  navigation: {
    action: (action) => ipcRenderer.invoke('navigation:action', action),
    edit: (action) => ipcRenderer.invoke('navigation:edit', action),
    showMenu: (menu, anchor) => ipcRenderer.invoke('navigation:show-menu', menu, anchor),
    closeMenu: () => ipcRenderer.invoke('navigation:close-menu'),
    onState: (callback) => subscribe('navigation:state', callback),
    onMenuAction: (callback) => subscribe('navigation:menu-action', callback),
    onMenuClosed: (callback) => subscribe('navigation:menu-closed', callback),
  },
  ui: {
    setModalOpen: (open) => ipcRenderer.invoke('ui:set-modal-open', Boolean(open)),
  },
});
