'use strict';

const path = require('node:path');
const fs = require('node:fs');
const util = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const packageMetadata = require('./package.json');
const { decodeMixedTextBuffer, decodeTextBuffer, isLikelyBinary } = require('./text-encoding');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  Tray,
  WebContentsView,
  nativeImage,
  shell,
} = require('electron');

const DSH_START_TIMEOUT_MS = 300_000;
const DSH_STOP_TIMEOUT_MS = 4_000;
const DSH_PACKAGE_NAME = packageMetadata.dshRuntime?.packageName;
const DSH_PACKAGE_SCOPE = String(DSH_PACKAGE_NAME || '').split('/')[0];
const DSH_REQUIRED_VERSION = packageMetadata.dshRuntime?.version;
const DSH_NPM_SPEC = `${DSH_PACKAGE_NAME}@${DSH_REQUIRED_VERSION}`;
const MIN_NODE_MAJOR = packageMetadata.dshRuntime?.minimumNodeMajor;
const PREFERRED_NODE_VERSION = packageMetadata.dshRuntime?.preferredNodeVersion;
const PREFERRED_NODE_SHA256 = packageMetadata.dshRuntime?.preferredNodeSha256;
const DSH_ALLOWED_INSTALL_SCRIPTS = [
  `@deepseek-ai/dsh-subprocess-local@${DSH_REQUIRED_VERSION}`,
  'node-pty@1.1.0',
  'koffi@3.1.5',
];
const DSH_INSTALL_ATTEMPTS_PER_REGISTRY = 2;
const DSH_INSTALL_TIMEOUT_MS = 10 * 60_000;
const NPM_REGISTRY_OFFICIAL = 'https://registry.npmjs.org/';
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com/';
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_BACKUP_COUNT = 4;
const HOST_RECOVERY_MAX_ATTEMPTS = 3;
const HOST_RECOVERY_STABLE_MS = 60_000;
const HOST_UI_LOAD_ATTEMPTS = 4;
const TOP_NAVIGATION_HEIGHT = 42;
const SIDEBAR_RAIL_WIDTH = 52;
const SIDEBAR_DEFAULT_WIDTH = 420;
const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 720;
const SIDEBAR_MAIN_MIN_WIDTH = 480;
const SIDEBAR_RESIZE_HANDLE_WIDTH = 5;
const SIDEBAR_BROWSER_TOP = 146;
const SIDEBAR_TOOLS = new Set(['review', 'terminal', 'browser', 'files', 'plugins']);
const REVIEW_SOURCES = new Set(['auto', 'git', 'svn']);
const PLUGIN_PROFILE_NAME = 'web';
const WORKSPACE_FILE_LIMIT = 800;
const WORKSPACE_TEXT_LIMIT = 1024 * 1024;
const MANAGED_RUNTIME_FS_MAX_RETRIES = 8;
const MANAGED_RUNTIME_FS_RETRY_DELAY_MS = 100;
const POWERSHELL_EXPAND_ARCHIVE_COMMAND =
  '& { param($archive, $destination) $ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }';

let mainWindow = null;
let harnessView = null;
let harnessViewReady = false;
let sidebarBrowserView = null;
let tray = null;
let dshProcess = null;
let dshUrl = null;
let bootstrapPromise = null;
let hostRecoveryPromise = null;
let hostRecoveryGeneration = 0;
let hostRecoveryAttempts = 0;
let hostStabilityTimer = null;
let hostMonitoringEnabled = false;
let logDirectory = null;
let logFilePath = null;
let installationSessionDepth = 0;
let installationCancellationRequested = false;
let installationClosePromptOpen = false;
let usingExternalHost = false;
let isQuitting = false;
let sidebarOpen = false;
let sidebarPanelWidth = SIDEBAR_DEFAULT_WIDTH;
let sidebarActiveTool = 'review';
let workspaceRoot = process.cwd();
let harnessWorkspaceSyncGeneration = 0;
let navigationPopupMenu = null;
let modalOverlayOpen = false;
let pluginOperationPromise = null;
const managedInstallationProcesses = new Set();
const managedInstallationDownloads = new Set();
const intentionalHostStops = new Set();
let currentServiceState = {
  state: 'starting',
  message: '正在启动 DeepSeek Harness…',
};

class EnvironmentRequirementsError extends Error {
  constructor(requirements) {
    super('需要安装运行环境');
    this.name = 'EnvironmentRequirementsError';
    this.requirements = requirements;
  }
}

configureUserDataOverride();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  registerAppLifecycle();
}

function configureUserDataOverride() {
  const prefix = '--dsh-user-data-dir=';
  const argument = process.argv.find((value) => String(value).startsWith(prefix));
  const directory = argument ? String(argument).slice(prefix.length).trim() : '';
  if (directory) app.setPath('userData', path.resolve(directory));
}

function registerAppLifecycle() {
  app.whenReady().then(() => {
    initializeLogging();
    createMainWindow();
    createTray();
    registerIpcHandlers();
    void bootstrapHarness();
  });

  app.on('activate', showMainWindow);
  app.on('window-all-closed', () => {});

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    installationCancellationRequested = true;
    cancelHostRecovery();
    if (installationSessionDepth > 0) {
      publishServiceState('installing', '正在取消安装并退出…');
    }
    void Promise.all([
      terminateManagedInstallationProcesses(),
      stopDshHost(),
    ]).finally(() => app.exit(0));
  });
}

function bootstrapHarness(options = {}) {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = runBootstrapHarness(options).finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

async function runBootstrapHarness(options = {}) {
  cancelHostRecovery();
  hostRecoveryAttempts = 0;
  publishServiceState('starting', '正在检查 DeepSeek Harness 运行环境…');
  destroyHarnessView();

  if (dshProcess && !usingExternalHost) await stopDshHost();
  if (hostRecoveryPromise) await hostRecoveryPromise;
  dshUrl = null;
  usingExternalHost = false;

  try {
    const existingHost = await findExistingHost();
    if (existingHost) {
      dshUrl = existingHost;
      usingExternalHost = true;
      publishServiceState('connecting', `已发现现有 Harness Host：${existingHost}`);
    } else {
      const installedDsh = await ensureGlobalDsh(options);
      await startDshHost(installedDsh);
    }
    await loadOfficialHarnessUi(dshUrl);
    if (!usingExternalHost) markHostHealthy();
    publishServiceState(
      'ready',
      usingExternalHost ? `已连接现有 Host（${new URL(dshUrl).port}）` : 'DeepSeek Harness 已就绪',
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof EnvironmentRequirementsError) {
      publishServiceState(
        'requirements',
        '检测到缺少的运行环境，请选择需要下载安装的项目',
        { requirements: error.requirements },
      );
      showMainWindow();
      return { ok: false, needsInstallation: true };
    }
    console.error('[desktop] Failed to start dsh:', error);
    if (isQuitting) return { ok: false, error: '客户端正在退出' };
    publishServiceState('error', error.message || 'DeepSeek Harness 启动失败');
    showMainWindow();
    return { ok: false, error: error.message || String(error) };
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#4b5563',
      height: TOP_NAVIGATION_HEIGHT,
    },
    title: 'DeepSeek Harness',
    backgroundColor: '#ffffff',
    icon: createAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('dsh:state', currentServiceState);
    publishSidebarState();
  });
  registerSidebarShortcut(mainWindow.webContents);
  mainWindow.on('resize', () => {
    layoutHarnessView();
    publishSidebarState();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (installationSessionDepth > 0) {
        void handleWindowCloseDuringInstallation();
      } else {
        mainWindow.hide();
      }
    }
  });
  mainWindow.on('closed', () => {
    destroySidebarBrowserView();
    harnessView = null;
    mainWindow = null;
  });
}

async function handleWindowCloseDuringInstallation() {
  if (!mainWindow || mainWindow.isDestroyed() || installationClosePromptOpen) return;
  installationClosePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'DeepSeek Harness 正在安装',
      message: '安装任务仍在进行',
      detail: '可以让安装在后台继续，也可以取消安装并退出客户端。',
      buttons: ['继续后台安装', '取消安装并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response === 1) {
      console.log('[install] 用户请求取消安装并退出客户端');
      app.quit();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  } finally {
    installationClosePromptOpen = false;
  }
}

function createTray() {
  tray = new Tray(createAppIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function registerIpcHandlers() {
  ipcMain.handle('dsh:retry', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return bootstrapHarness();
  });

  ipcMain.handle('dsh:install-requirements', async (event, request) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    const installRequirements = Array.isArray(request?.requirements)
      ? [...new Set(request.requirements.filter((item) => item === 'node' || item === 'dsh'))]
      : [];
    const nodeInstallMethod = request?.nodeInstallMethod === 'winget' ? 'winget' : 'managed';
    if (!installRequirements.length) return { ok: false, error: '请至少选择一个安装项目' };
    return bootstrapHarness({ installRequirements, nodeInstallMethod });
  });

  ipcMain.handle('dsh:open-logs', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    if (!logDirectory) return { ok: false, error: '日志目录尚未初始化' };
    const error = await shell.openPath(logDirectory);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('dsh:copy-diagnostics', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    const diagnostics = await createDiagnosticReport();
    clipboard.writeText(diagnostics);
    return { ok: true };
  });

  ipcMain.handle('dsh:check-environment', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return inspectRuntimeEnvironment();
  });

  ipcMain.handle('dsh:restart', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    if (usingExternalHost) return { ok: false, error: '当前连接的是外部 Harness Host，无法由桌面端重启' };
    return bootstrapHarness();
  });

  ipcMain.handle('plugins:list', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return getPluginManagerState();
  });

  ipcMain.handle('plugins:add', async (event, packageSpec) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return runPluginOperation('add', packageSpec);
  });

  ipcMain.handle('plugins:remove', async (event, packageName) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return runPluginOperation('remove', packageName);
  });

  ipcMain.handle('sidebar:get-state', (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return {
      ok: true,
      open: sidebarOpen,
      tool: sidebarActiveTool,
      width: getSidebarWidth(),
      panelWidth: getSidebarPanelWidth(),
      workspace: workspaceRoot,
    };
  });

  ipcMain.handle('sidebar:set-open', (event, open) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    sidebarOpen = Boolean(open);
    layoutHarnessView();
    publishSidebarState();
    return { ok: true, open: sidebarOpen, tool: sidebarActiveTool, width: getSidebarWidth(), panelWidth: getSidebarPanelWidth() };
  });

  ipcMain.handle('sidebar:set-width', (event, width) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    sidebarPanelWidth = clampSidebarPanelWidth(width);
    layoutHarnessView();
    publishSidebarState();
    return { ok: true, open: sidebarOpen, width: getSidebarWidth(), panelWidth: getSidebarPanelWidth() };
  });

  ipcMain.handle('sidebar:set-tool', (event, tool, options = {}) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    if (!SIDEBAR_TOOLS.has(tool)) return { ok: false, error: '未知的侧边栏功能' };
    sidebarActiveTool = tool;
    if (options?.open !== false) sidebarOpen = true;
    layoutHarnessView();
    publishSidebarState();
    return { ok: true, open: sidebarOpen, tool, width: getSidebarWidth(), panelWidth: getSidebarPanelWidth() };
  });

  ipcMain.handle('workspace:get', (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return { ok: true, path: workspaceRoot, name: path.basename(workspaceRoot) };
  });

  ipcMain.handle('workspace:choose', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作区文件夹',
      defaultPath: workspaceRoot,
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    updateWorkspaceRoot(result.filePaths[0], 'manual');
    return { ok: true, path: workspaceRoot, name: path.basename(workspaceRoot) };
  });

  ipcMain.on('harness:workspace-selection', (event, selection) => {
    if (event.sender !== harnessView?.webContents) return;
    void syncWorkspaceFromHarness(selection);
  });

  ipcMain.handle('workspace:list-files', async (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    try {
      return { ok: true, path: workspaceRoot, files: await listWorkspaceFiles(workspaceRoot) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace:read-file', async (event, relativePath) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    try {
      return { ok: true, ...(await readWorkspaceFile(relativePath)) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('review:get', async (event, source = 'auto') => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    if (!REVIEW_SOURCES.has(source)) return { ok: false, error: '未知的版本控制类型' };
    return getWorkspaceReview(source);
  });

  ipcMain.handle('review:get-file-diff', async (event, source, relativePath) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    if (source !== 'git' && source !== 'svn') return { ok: false, error: '请先选择 Git 或 SVN' };
    try {
      return await getWorkspaceFileDiff(source, relativePath);
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('terminal:run', async (event, command) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    const sender = event.sender;
    return runTerminalCommand(command, (stream, text) => {
      if (!text || sender.isDestroyed()) return;
      sender.send('terminal:output', { stream, text });
    });
  });

  ipcMain.handle('browser:navigate', async (event, target) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    try {
      const url = normalizeBrowserUrl(target);
      const view = ensureSidebarBrowserView();
      await view.webContents.loadURL(url);
      return { ok: true, url: view.webContents.getURL(), title: view.webContents.getTitle() };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('browser:action', (event, action) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    const view = sidebarBrowserView;
    if (!view || view.webContents.isDestroyed()) return { ok: false, error: '浏览器尚未打开' };
    if (action === 'back' && canBrowserGoBack(view.webContents)) goBrowserBack(view.webContents);
    else if (action === 'forward' && canBrowserGoForward(view.webContents)) goBrowserForward(view.webContents);
    else if (action === 'reload') view.webContents.reload();
    else if (action === 'stop') view.webContents.stop();
    return { ok: true };
  });

  ipcMain.handle('navigation:action', (event, action) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    const contents = getNavigationContents();
    if (!contents || contents.isDestroyed()) return { ok: false, error: '当前没有可导航的页面' };
    if (action === 'back' && canBrowserGoBack(contents)) goBrowserBack(contents);
    else if (action === 'forward' && canBrowserGoForward(contents)) goBrowserForward(contents);
    else if (action === 'reload') contents.reload();
    publishNavigationState();
    return { ok: true };
  });

  ipcMain.handle('navigation:edit', (event, action) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    if (action === 'copy') event.sender.copy();
    else if (action === 'paste') event.sender.paste();
    else if (action === 'select-all') event.sender.selectAll();
    else return { ok: false, error: '未知的编辑操作' };
    return { ok: true };
  });

  ipcMain.handle('navigation:show-menu', (event, menu, anchor) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    return showNavigationMenu(menu, anchor);
  });

  ipcMain.handle('navigation:close-menu', (event) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    navigationPopupMenu?.closePopup(mainWindow);
    return { ok: true };
  });

  ipcMain.handle('ui:set-modal-open', (event, open) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: '无效的请求来源' };
    modalOverlayOpen = Boolean(open);
    if (harnessView && !harnessView.webContents.isDestroyed()) {
      harnessView.setVisible(harnessViewReady && !modalOverlayOpen);
    }
    layoutHarnessView();
    return { ok: true, open: modalOverlayOpen };
  });
}

function showNavigationMenu(menuName, anchor = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不存在' };
  const template = createNavigationMenuTemplate(menuName);
  if (!template) return { ok: false, error: '未知的导航菜单' };
  navigationPopupMenu?.closePopup(mainWindow);
  const popup = Menu.buildFromTemplate(template);
  navigationPopupMenu = popup;
  const x = Math.max(0, Math.round(Number(anchor.x) || 0));
  const y = Math.max(TOP_NAVIGATION_HEIGHT, Math.round(Number(anchor.y) || TOP_NAVIGATION_HEIGHT));
  popup.popup({
    window: mainWindow,
    x,
    y,
    callback: () => {
      if (navigationPopupMenu === popup) navigationPopupMenu = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('navigation:menu-closed');
    },
  });
  return { ok: true };
}

function createNavigationMenuTemplate(menuName) {
  const action = (label, actionName, accelerator) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('navigation:menu-action', actionName);
      }
    },
  });
  if (menuName === 'file') {
    return [
      action('选择工作区…', 'choose-workspace'),
      action('打开日志目录', 'open-logs'),
    ];
  }
  if (menuName === 'edit') {
    return [
      action('复制', 'copy', 'CmdOrCtrl+C'),
      action('粘贴', 'paste', 'CmdOrCtrl+V'),
      action('全选', 'select-all', 'CmdOrCtrl+A'),
    ];
  }
  if (menuName === 'view') {
    return [
      action('刷新当前页面', 'reload', 'CmdOrCtrl+R'),
      action('重启 Harness 服务', 'restart-harness'),
      { type: 'separator' },
      action('审阅', 'tool-review', 'CmdOrCtrl+Shift+G'),
      action('终端', 'tool-terminal'),
      action('浏览器', 'tool-browser', 'CmdOrCtrl+T'),
      action('文件', 'tool-files', 'CmdOrCtrl+P'),
      action('插件管理', 'tool-plugins'),
      { type: 'separator' },
      action('切换侧边栏', 'toggle-sidebar', 'CmdOrCtrl+Shift+S'),
    ];
  }
  if (menuName === 'help') {
    return [
      action('检查运行环境', 'check-environment'),
      { type: 'separator' },
      action('复制诊断信息', 'copy-diagnostics'),
    ];
  }
  return null;
}

async function listWorkspaceFiles(root) {
  const ignoredDirectories = new Set(['.git', 'node_modules', 'release', 'dist', 'build', '.next', '.cache']);
  const entries = [];

  async function visit(directory, depth) {
    if (entries.length >= WORKSPACE_FILE_LIMIT || depth > 7) return;
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    for (const child of children) {
      if (entries.length >= WORKSPACE_FILE_LIMIT) break;
      if (child.name.startsWith('.') && child.name !== '.env.example') continue;
      if (child.isDirectory() && ignoredDirectories.has(child.name)) continue;
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const item = { name: child.name, path: relativePath, depth, directory: child.isDirectory() };
      entries.push(item);
      if (child.isDirectory() && !child.isSymbolicLink()) await visit(absolutePath, depth + 1);
    }
  }

  await visit(root, 0);
  return entries;
}

function resolveWorkspacePath(relativePath) {
  const candidate = path.resolve(workspaceRoot, String(relativePath || ''));
  const relative = path.relative(path.resolve(workspaceRoot), candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件不在当前工作区内');
  return candidate;
}

async function readWorkspaceFile(relativePath) {
  const absolutePath = resolveWorkspacePath(relativePath);
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) throw new Error('请选择一个文件');
  if (stat.size > WORKSPACE_TEXT_LIMIT) throw new Error('文件超过 1 MB，无法在侧边栏预览');
  const buffer = await fs.promises.readFile(absolutePath);
  const decoded = decodeTextBuffer(buffer);
  if (isLikelyBinary(buffer, decoded)) throw new Error('二进制文件无法预览');
  return {
    path: path.relative(workspaceRoot, absolutePath).split(path.sep).join('/'),
    content: decoded.text,
    encoding: decoded.encoding,
    size: stat.size,
  };
}

function updateWorkspaceRoot(candidate, source) {
  const nextRoot = path.resolve(String(candidate || ''));
  if (!isExistingDirectory(nextRoot)) return false;
  if (path.normalize(nextRoot).toLowerCase() === path.normalize(workspaceRoot).toLowerCase()) return false;
  workspaceRoot = nextRoot;
  publishSidebarState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('workspace:changed', {
      path: workspaceRoot,
      name: path.basename(workspaceRoot),
      source,
    });
  }
  console.log(`[workspace] 已切换至 ${workspaceRoot}（source=${source}）`);
  return true;
}

async function syncWorkspaceFromHarness(selection) {
  const sessionId = typeof selection?.sessionId === 'string' ? selection.sessionId : '';
  const parentSessionId = typeof selection?.parentSessionId === 'string' ? selection.parentSessionId : '';
  if (!sessionId && !parentSessionId) return;
  const generation = ++harnessWorkspaceSyncGeneration;
  for (const waitMs of [0, 100, 350, 800]) {
    if (waitMs) await delay(waitMs);
    if (generation !== harnessWorkspaceSyncGeneration) return;
    const selectedPath = await resolveHarnessWorkspacePath(sessionId, parentSessionId);
    if (!selectedPath) continue;
    updateWorkspaceRoot(selectedPath, 'harness');
    return;
  }
  console.warn(`[workspace] 无法解析 Harness 当前会话所属工作区：${sessionId || parentSessionId}`);
}

async function resolveHarnessWorkspacePath(sessionId, parentSessionId) {
  const storageRoot = path.join(app.getPath('home'), '.dsh', 'storages');
  const candidateSessionIds = [parentSessionId, sessionId].filter(Boolean);
  try {
    const workspaceState = JSON.parse(await fs.promises.readFile(path.join(storageRoot, 'workspace.json'), 'utf8'));
    const workspaces = Object.values(workspaceState?.tables?.workspaces || {});
    const matched = workspaces.find((workspace) => (
      Array.isArray(workspace?.sessionIds)
      && candidateSessionIds.some((candidate) => workspace.sessionIds.includes(candidate))
    ));
    if (isExistingDirectory(matched?.path)) return path.resolve(matched.path);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[workspace] 无法读取 Harness 工作区存储', error);
  }

  try {
    const projectionState = JSON.parse(await fs.promises.readFile(path.join(storageRoot, 'session_projcache.json'), 'utf8'));
    for (const candidate of candidateSessionIds) {
      const cwd = projectionState?.tables?.sessions?.[candidate]?.identity?.cwd;
      if (isExistingDirectory(cwd)) return path.resolve(cwd);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[workspace] 无法读取 Harness 会话投影', error);
  }
  return null;
}

function isExistingDirectory(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  try {
    return fs.statSync(path.resolve(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function getPluginManagerState() {
  const profileRoot = path.join(app.getPath('home'), '.dsh', 'profiles', PLUGIN_PROFILE_NAME);
  const packageFile = path.join(profileRoot, 'package.json');
  try {
    if (!fs.existsSync(packageFile)) {
      return {
        ok: false,
        profile: PLUGIN_PROFILE_NAME,
        profileRoot,
        error: `未找到 ${PLUGIN_PROFILE_NAME} profile：${profileRoot}`,
      };
    }
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const dependencies = metadata.dependencies && typeof metadata.dependencies === 'object'
      ? metadata.dependencies
      : {};
    const plugins = Object.entries(dependencies)
      .map(([name, version]) => ({ name, version: String(version) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    return { ok: true, profile: PLUGIN_PROFILE_NAME, profileRoot, plugins };
  } catch (error) {
    return {
      ok: false,
      profile: PLUGIN_PROFILE_NAME,
      profileRoot,
      error: `无法读取插件配置：${error.message || error}`,
    };
  }
}

async function runPluginOperation(action, input) {
  if (pluginOperationPromise) return { ok: false, busy: true, error: '已有插件操作正在进行' };
  let request;
  try {
    request = parsePluginPackageInput(input, action === 'add');
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
  pluginOperationPromise = performPluginOperation(action, request).finally(() => {
    pluginOperationPromise = null;
  });
  return pluginOperationPromise;
}

function parsePluginPackageInput(value, allowVersion) {
  const input = String(value || '').trim();
  if (!input || input.length > 214 || /[\s\0-\x1f]/.test(input)) {
    throw new Error('请输入有效的 npm 插件包名');
  }
  const namePattern = '[a-z0-9][a-z0-9._-]*';
  const versionPattern = '[a-z0-9._~^*+<>=|-]+';
  const scoped = input.match(new RegExp(`^(@${namePattern}/${namePattern})(?:@(${versionPattern}))?$`, 'i'));
  const unscoped = input.match(new RegExp(`^(${namePattern})(?:@(${versionPattern}))?$`, 'i'));
  const match = scoped || unscoped;
  if (!match || (!allowVersion && match[2])) {
    throw new Error(allowVersion ? '仅支持 npm 注册表包名及可选版本' : '请输入已安装插件的完整包名');
  }
  return { spec: input, name: match[1] };
}

async function performPluginOperation(action, request) {
  const current = await getPluginManagerState();
  if (!current.ok) return current;
  if (action === 'remove' && !current.plugins.some((plugin) => plugin.name === request.name)) {
    return { ok: false, error: `插件未安装：${request.name}` };
  }

  let dsh;
  try {
    dsh = await findDshRuntimeForPluginManager();
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
  const command = action === 'add' ? 'add' : 'remove';
  const result = await withInstallationSession(() => runProcess(
    dsh.node,
    [dsh.cli, 'plugin', '--profile', PLUGIN_PROFILE_NAME, command, action === 'add' ? request.spec : request.name],
    DSH_INSTALL_TIMEOUT_MS,
    true,
    true,
    createRuntimeProcessEnvironment(dsh),
  ));
  if (result.cancelled) return { ok: false, error: '插件操作已取消' };
  if (result.code !== 0) {
    return {
      ok: false,
      error: tail(result.stderr || result.stdout, 1_200) || `插件${action === 'add' ? '安装' : '卸载'}失败`,
    };
  }
  const state = await getPluginManagerState();
  return state.ok
    ? { ...state, restartRequired: true, changedPlugin: request.name, action }
    : state;
}

async function findDshRuntimeForPluginManager() {
  const runtimes = await findNpmRuntimes();
  for (const runtime of runtimes.filter((candidate) => candidate.major >= MIN_NODE_MAJOR)) {
    const profilePackageRoot = path.join(
      app.getPath('home'), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh',
    );
    const profileDsh = await validateDshInstallation(runtime.node, profilePackageRoot);
    if (profileDsh) return profileDsh;
    try {
      const npmRoot = await getGlobalNpmRoot(runtime);
      const globalDsh = await validateDshInstallation(
        runtime.node,
        path.join(npmRoot, '@deepseek-ai', 'dsh'),
      );
      if (globalDsh) return globalDsh;
    } catch (error) {
      console.error(`[plugins] 无法检查 npm 全局目录：${error.message || error}`);
    }
  }
  throw new Error('未找到可用的 dsh CLI，请先完成运行环境安装');
}

async function getWorkspaceReview(requestedSource = 'auto') {
  const detected = await detectWorkspaceVersionControl();
  const source = requestedSource === 'auto' ? detected.source : requestedSource;
  if (!source) {
    const commandsMissing = detected.git.missing && detected.svn.missing;
    return {
      ok: false,
      source: null,
      detectedSource: null,
      error: commandsMissing
        ? '未检测到 Git 或 SVN 命令行工具，请安装相应工具后重试'
        : '当前工作区不是 Git 仓库或 SVN 工作副本，可在上方手动选择版本控制类型',
    };
  }

  const probe = detected[source];
  if (!probe.root) {
    const label = source === 'git' ? 'Git' : 'SVN';
    const detectedLabel = detected.source === 'git' ? 'Git' : detected.source === 'svn' ? 'SVN' : null;
    return {
      ok: false,
      source,
      detectedSource: detected.source,
      error: probe.missing
        ? `未检测到 ${label} 命令行工具`
        : `当前工作区不是 ${label}${source === 'git' ? ' 仓库' : ' 工作副本'}`
          + (detectedLabel ? `；已自动识别为 ${detectedLabel}，可切换回“自动”` : ''),
    };
  }

  const review = source === 'git'
    ? await getGitWorkspaceReview(probe.targets)
    : await getSvnWorkspaceReview(probe.targets);
  return { ...review, source, detectedSource: detected.source, roots: probe.roots };
}

async function detectWorkspaceVersionControl() {
  const [git, svn] = await Promise.all([inspectGitWorkspace(), inspectSvnWorkspace()]);
  const matches = [
    ...(git.root ? [{ source: 'git', root: git.root }] : []),
    ...(svn.root ? [{ source: 'svn', root: svn.root }] : []),
  ].sort((left, right) => getWorkspaceRootDepth(right.root) - getWorkspaceRootDepth(left.root));
  return { source: matches[0]?.source || null, git, svn };
}

async function inspectGitWorkspace() {
  const result = await runWorkspaceProcess('git.exe', ['rev-parse', '--show-toplevel'], 20_000);
  const missing = result.code === -1 && /ENOENT|not found/i.test(result.stderr);
  const directRoot = result.code === 0 ? normalizeDetectedWorkspaceRoot(result.stdout) : null;
  const childRoots = !directRoot && !missing ? findImmediateChildVersionControlRoots('.git') : [];
  const roots = directRoot ? [directRoot] : childRoots;
  return {
    root: roots[0] || null,
    roots,
    targets: directRoot ? [workspaceRoot] : childRoots,
    missing,
    error: result.stderr.trim(),
  };
}

async function inspectSvnWorkspace() {
  let result = await runWorkspaceProcess('svn.exe', ['info', '--show-item', 'wc-root'], 20_000);
  let root = result.code === 0 ? normalizeDetectedWorkspaceRoot(result.stdout) : null;
  if (!root && result.code !== -1) {
    result = await runWorkspaceProcess('svn.exe', ['info', '--xml'], 20_000);
    const match = result.code === 0 ? result.stdout.match(/<wcroot-abspath>([\s\S]*?)<\/wcroot-abspath>/i) : null;
    root = match ? normalizeDetectedWorkspaceRoot(decodeXmlText(match[1])) : null;
  }
  const missing = result.code === -1 && /ENOENT|not found/i.test(result.stderr);
  const childRoots = !root && !missing ? findImmediateChildVersionControlRoots('.svn') : [];
  const roots = root ? [root] : childRoots;
  return {
    root: roots[0] || null,
    roots,
    targets: root ? [workspaceRoot] : childRoots,
    missing,
    error: result.stderr.trim(),
  };
}

function findImmediateChildVersionControlRoots(marker) {
  try {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(workspaceRoot, entry.name, marker)))
      .map((entry) => path.join(workspaceRoot, entry.name));
  } catch (error) {
    console.error(`[review] 无法扫描工作区中的 ${marker} 项目`, error);
    return [];
  }
}

function normalizeDetectedWorkspaceRoot(value) {
  const root = String(value || '').trim();
  return root ? path.resolve(root) : null;
}

function getWorkspaceRootDepth(root) {
  return path.resolve(root).split(path.sep).filter(Boolean).length;
}

function decodeXmlText(value) {
  return String(value || '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hexadecimal) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity.toLowerCase()] || entity;
  });
}

async function getGitWorkspaceReview(targets) {
  const files = [];
  const statuses = [];
  for (const target of targets) {
    const [status, porcelain] = await Promise.all([
      runWorkspaceProcess('git.exe', ['status', '--short', '--branch', '--', '.'], 20_000, { cwd: target }),
      runWorkspaceProcess('git.exe', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], 20_000, { cwd: target }),
    ]);
    if (status.code !== 0 || porcelain.code !== 0) {
      return { ok: false, error: (status.stderr || porcelain.stderr).trim() || '无法读取 Git 工作区状态' };
    }
    if (status.stdout.trim()) statuses.push(status.stdout.trim());
    files.push(...parseGitStatusFiles(porcelain.stdout, target));
  }
  return {
    ok: true,
    status: statuses.join('\n'),
    files: files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN')),
  };
}

async function getSvnWorkspaceReview(targets) {
  const batches = createCommandArgumentBatches(targets, 12_000);
  const results = [];
  for (const batch of batches) {
    results.push(await runWorkspaceProcess('svn.exe', ['status', '--xml', '--', ...batch], 60_000));
  }
  const failed = results.find((result) => result.code !== 0);
  if (failed) {
    return {
      ok: false,
      error: failed.stderr.trim() || '无法读取 SVN 工作副本状态',
    };
  }
  return {
    ok: true,
    status: '',
    files: results
      .flatMap((result) => parseSvnStatusFiles(result.stdout))
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN')),
  };
}

function createCommandArgumentBatches(values, maximumCharacters) {
  const batches = [];
  let batch = [];
  let length = 0;
  for (const value of values) {
    const additionalLength = String(value).length + 3;
    if (batch.length && length + additionalLength > maximumCharacters) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(value);
    length += additionalLength;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function parseGitStatusFiles(output, targetRoot) {
  const entries = String(output || '').split('\0');
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const relativePath = normalizeReviewPath(path.resolve(targetRoot, entry.slice(3)));
    if (relativePath) files.push({ path: relativePath, status: status.trim() || 'M' });
    if (/[RC]/.test(status)) index += 1;
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

function parseSvnStatusFiles(output) {
  const files = [];
  const entryPattern = /<entry\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/gi;
  for (const match of String(output || '').matchAll(entryPattern)) {
    const statusTag = match[2].match(/<wc-status\b([^>]*)/i)?.[1] || '';
    const item = statusTag.match(/\bitem="([^"]+)"/i)?.[1] || 'normal';
    const properties = statusTag.match(/\bprops="([^"]+)"/i)?.[1] || 'none';
    if (item === 'normal' && properties === 'none') continue;
    const relativePath = normalizeReviewPath(decodeXmlText(match[1]));
    if (!relativePath) continue;
    const absolutePath = resolveWorkspacePath(relativePath);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) continue;
    files.push({ path: relativePath, status: getSvnStatusCode(item, properties) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

function getSvnStatusCode(item, properties) {
  if (item === 'normal' && properties !== 'none') return 'M';
  return {
    added: 'A',
    conflicted: 'C',
    deleted: 'D',
    external: 'X',
    ignored: 'I',
    incomplete: '!',
    merged: 'G',
    missing: '!',
    modified: 'M',
    obstructed: '~',
    replaced: 'R',
    unversioned: '?',
  }[item] || item.slice(0, 1).toUpperCase();
}

function normalizeReviewPath(value) {
  const absolutePath = path.resolve(workspaceRoot, String(value || ''));
  const relativePath = path.relative(path.resolve(workspaceRoot), absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return relativePath.split(path.sep).join('/');
}

async function getWorkspaceFileDiff(source, relativePath) {
  const absolutePath = resolveWorkspacePath(relativePath);
  const normalizedPath = path.relative(workspaceRoot, absolutePath).split(path.sep).join('/');
  if (!normalizedPath) throw new Error('请选择一个变更文件');
  const repositoryRoot = findContainingVersionControlRoot(absolutePath, source === 'git' ? '.git' : '.svn');
  if (!repositoryRoot) throw new Error(`无法定位该文件所属的 ${source === 'git' ? 'Git' : 'SVN'} 工作区`);
  const repositoryPath = path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
  const diff = source === 'git'
    ? await getGitFileDiff(repositoryRoot, repositoryPath, normalizedPath)
    : await getSvnFileDiff(repositoryRoot, repositoryPath, normalizedPath);
  return { ok: true, source, path: normalizedPath, diff };
}

function findContainingVersionControlRoot(absolutePath, marker) {
  let directory = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
    ? absolutePath
    : path.dirname(absolutePath);
  while (true) {
    if (fs.existsSync(path.join(directory, marker))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function getGitFileDiff(repositoryRoot, repositoryPath, workspacePath) {
  const [unstaged, staged] = await Promise.all([
    runWorkspaceProcess('git.exe', ['-c', 'color.ui=false', 'diff', '--no-ext-diff', '--unified=3', '--', repositoryPath], 30_000, { cwd: repositoryRoot, encoding: 'auto' }),
    runWorkspaceProcess('git.exe', ['-c', 'color.ui=false', 'diff', '--cached', '--no-ext-diff', '--unified=3', '--', repositoryPath], 30_000, { cwd: repositoryRoot, encoding: 'auto' }),
  ]);
  if (unstaged.code !== 0 || staged.code !== 0) {
    throw new Error((unstaged.stderr || staged.stderr).trim() || '无法读取 Git 文件差异');
  }
  const diff = [
    staged.stdout.trim() ? `# 已暂存\n${staged.stdout.trim()}` : '',
    unstaged.stdout.trim() ? `# 未暂存\n${unstaged.stdout.trim()}` : '',
  ].filter(Boolean).join('\n\n');
  return diff || await createUnversionedFileDiff('git', repositoryRoot, repositoryPath, workspacePath);
}

async function getSvnFileDiff(repositoryRoot, repositoryPath, workspacePath) {
  const result = await runWorkspaceProcess('svn.exe', ['diff', '--', repositoryPath], 30_000, { cwd: repositoryRoot, encoding: 'auto' });
  if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取 SVN 文件差异');
  return result.stdout.trim() || await createUnversionedFileDiff('svn', repositoryRoot, repositoryPath, workspacePath);
}

async function createUnversionedFileDiff(source, repositoryRoot, repositoryPath, workspacePath) {
  const statusArguments = source === 'git'
    ? ['status', '--porcelain=v1', '--untracked-files=all', '--', repositoryPath]
    : ['status', '--', repositoryPath];
  const executable = source === 'git' ? 'git.exe' : 'svn.exe';
  const status = await runWorkspaceProcess(executable, statusArguments, 20_000, { cwd: repositoryRoot });
  const unversioned = source === 'git'
    ? status.stdout.startsWith('??')
    : status.stdout.trimStart().startsWith('?');
  if (!unversioned || !fs.existsSync(resolveWorkspacePath(workspacePath))) return '';
  const file = await readWorkspaceFile(workspacePath);
  const lines = file.content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return [
    `--- /dev/null`,
    `+++ ${workspacePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

async function runTerminalCommand(command, onOutput = null) {
  const value = String(command || '').trim();
  if (!value) return { ok: false, error: '请输入命令' };
  if (value.length > 4_000) return { ok: false, error: '命令过长' };
  const preparedCommand = prepareTerminalCommand(value);
  const encodedCommand = Buffer.from(value, 'utf8').toString('base64');
  const nativeEncodingExpression = preparedCommand.utf8NativeOutput
    ? '[System.Text.UTF8Encoding]::new($false)'
    : '[System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)';
  const utf8Command = [
    `$nativeEncoding = ${nativeEncodingExpression};`,
    '[Console]::InputEncoding = $nativeEncoding;',
    '[Console]::OutputEncoding = $nativeEncoding;',
    '$OutputEncoding = $nativeEncoding;',
    '$nativeExitCode = 0;',
    '$LASTEXITCODE = $null;',
    'try {',
    `$script = [scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCommand}')));`,
    '& $script;',
    'if ($null -ne $LASTEXITCODE) { $nativeExitCode = $LASTEXITCODE }',
    '} catch {',
    '[Console]::Error.Write(($_ | Out-String -Width 4096));',
    '$nativeExitCode = 1;',
    '}',
    'exit $nativeExitCode;',
  ].join(' ');
  const result = await runWorkspaceProcess(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', utf8Command],
    120_000,
    {
      encoding: preparedCommand.utf8NativeOutput ? 'utf8' : 'oem',
      onOutput,
    },
  );
  return {
    ok: true,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    streamed: Boolean(onOutput),
    cwd: workspaceRoot,
  };
}

function prepareTerminalCommand(command) {
  return {
    utf8NativeOutput: /^(?:dsh|node|npm|npx|pnpm)(?:\.cmd|\.ps1|\.exe)?(?:\s|$)/i.test(command),
  };
}

function runWorkspaceProcess(executable, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const autoEncoding = options.encoding === 'auto';
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timer = null;
    const stdoutDecoder = autoEncoding ? null : createTerminalDecoder(options.encoding);
    const stderrDecoder = autoEncoding ? null : createTerminalDecoder(options.encoding);
    const managedNodeDirectory = getManagedNodeDirectory();
    const env = {
      ...process.env,
      PATH: fs.existsSync(managedNodeDirectory)
        ? `${managedNodeDirectory}${path.delimiter}${process.env.PATH || ''}`
        : process.env.PATH,
    };
    const child = spawn(executable, args, {
      cwd: options.cwd || workspaceRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const emitOutput = (stream, text) => {
      if (!text) return;
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      options.onOutput?.(stream, text);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (autoEncoding) {
        emitOutput('stdout', decodeMixedTextBuffer(Buffer.concat(stdoutChunks)).text);
        emitOutput('stderr', decodeMixedTextBuffer(Buffer.concat(stderrChunks)).text);
      } else {
        emitOutput('stdout', stdoutDecoder.decode());
        emitOutput('stderr', stderrDecoder.decode());
      }
      resolve({ code, stdout: stdout.slice(-WORKSPACE_TEXT_LIMIT), stderr: stderr.slice(-WORKSPACE_TEXT_LIMIT) });
    };
    child.stdout.on('data', (chunk) => {
      if (autoEncoding) stdoutChunks.push(Buffer.from(chunk));
      else emitOutput('stdout', stdoutDecoder.decode(chunk, { stream: true }));
    });
    child.stderr.on('data', (chunk) => {
      if (autoEncoding) stderrChunks.push(Buffer.from(chunk));
      else emitOutput('stderr', stderrDecoder.decode(chunk, { stream: true }));
    });
    child.once('error', (error) => { stderr += error.message; finish(-1); });
    child.once('close', (code) => finish(code ?? -1));
    timer = setTimeout(() => {
      stderr += `\n命令执行超时（${Math.round(timeoutMs / 1000)} 秒）`;
      void terminateProcessTree(child).finally(() => finish(-1));
    }, timeoutMs);
  });
}

function createTerminalDecoder(encoding) {
  if (encoding !== 'oem') return new TextDecoder('utf-8');
  const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  if (locale.startsWith('zh')) return new TextDecoder('gbk');
  if (locale.startsWith('ja')) return new TextDecoder('shift_jis');
  if (locale.startsWith('ko')) return new TextDecoder('euc-kr');
  if (locale.startsWith('ru') || locale.startsWith('uk')) return new TextDecoder('ibm866');
  return new TextDecoder('windows-1252');
}

function normalizeBrowserUrl(target) {
  const raw = String(target || '').trim();
  if (!raw) return 'https://www.bing.com/';
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 HTTP 或 HTTPS 地址');
  return parsed.href;
}

function initializeLogging() {
  try {
    logDirectory = app.getPath('logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    logFilePath = path.join(logDirectory, 'desktop.log');
    rotateLogFile();

    for (const [method, level] of [
      ['log', 'INFO'],
      ['warn', 'WARN'],
      ['error', 'ERROR'],
    ]) {
      const original = console[method].bind(console);
      console[method] = (...values) => {
        original(...values);
        writePersistentLog(level, values);
      };
    }
    console.log(`[desktop] 日志文件：${logFilePath}`);
  } catch (error) {
    logDirectory = null;
    logFilePath = null;
    console.error('[desktop] 无法初始化持久日志：', error);
  }
}

function rotateLogFile() {
  if (!logFilePath || !fs.existsSync(logFilePath)) return;
  if (fs.statSync(logFilePath).size < LOG_FILE_MAX_BYTES) return;

  for (let index = LOG_BACKUP_COUNT; index >= 1; index -= 1) {
    const source = index === 1 ? logFilePath : `${logFilePath}.${index - 1}`;
    const destination = `${logFilePath}.${index}`;
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
    fs.renameSync(source, destination);
  }
}

function writePersistentLog(level, values) {
  if (!logFilePath) return;
  try {
    const message = values.map(formatLogValue).join(' ');
    fs.appendFileSync(
      logFilePath,
      `${new Date().toISOString()} [${level}] ${redactLogText(message)}\n`,
      'utf8',
    );
  } catch {}
}

function formatLogValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  return util.inspect(value, { depth: 5, breakLength: 160, maxArrayLength: 50 });
}

function redactLogText(value) {
  return String(value)
    .replace(/((?:_authToken|authToken|password|secret)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

async function createDiagnosticReport() {
  let nodeSummary = '未检测';
  try {
    const runtimes = await findNpmRuntimes();
    nodeSummary = runtimes.length
      ? runtimes.map((runtime) => (
        `${runtime.version} / npm ${runtime.npmVersion} (${runtime.node})`
      )).join('; ')
      : '未检测';
  } catch (error) {
    nodeSummary = `检测失败：${error.message}`;
  }

  return [
    'DeepSeek Harness Desktop 诊断信息',
    `客户端版本：${app.getVersion()}`,
    `Electron：${process.versions.electron}`,
    `Windows：${process.getSystemVersion()} (${process.arch})`,
    `Node.js：${nodeSummary}`,
    `要求的 dsh：${DSH_REQUIRED_VERSION}`,
    `服务状态：${currentServiceState.state} - ${currentServiceState.message}`,
    `Host：${dshUrl || '未连接'}`,
    `Host PID：${dshProcess?.pid || '无'}`,
    `外部 Host：${usingExternalHost ? '是' : '否'}`,
    `Host 自动恢复：${hostRecoveryPromise ? '进行中' : '空闲'}，次数 ${hostRecoveryAttempts}/${HOST_RECOVERY_MAX_ATTEMPTS}`,
    `安装任务：${installationSessionDepth > 0 ? '进行中' : '无'}`,
    `安装进程 PID：${[...managedInstallationProcesses].map((child) => child.pid).filter(Boolean).join(', ') || '无'}`,
    `安装下载任务：${managedInstallationDownloads.size}`,
    `日志文件：${logFilePath || '未初始化'}`,
    `生成时间：${new Date().toISOString()}`,
  ].join('\r\n');
}

async function inspectRuntimeEnvironment() {
  const items = [];
  let runtime = null;
  try {
    const runtimes = await findNpmRuntimes();
    runtime = runtimes.find((candidate) => candidate.major >= MIN_NODE_MAJOR) || null;
  } catch (error) {
    items.push({ name: 'Node.js / npm', ok: false, detail: `检测失败：${error.message || error}` });
  }
  if (!runtime) {
    if (!items.length) {
      items.push({ name: 'Node.js', ok: false, detail: `未检测到兼容版本（最低 v${MIN_NODE_MAJOR}）` });
      items.push({ name: 'npm', ok: false, detail: '未检测' });
    }
    items.push({ name: 'dsh', ok: false, detail: `未检测（需要 ${DSH_REQUIRED_VERSION}）` });
    items.push({ name: 'pnpm', ok: false, optional: true, detail: '未检测（可选，不影响 Harness 运行）' });
    return { ok: false, items };
  }

  items.push({ name: 'Node.js', ok: true, detail: `${runtime.version}（${runtime.node}）` });
  items.push({ name: 'npm', ok: true, detail: runtime.npmVersion });
  let dsh = null;
  try {
    const npmRoot = await getGlobalNpmRoot(runtime);
    const packageRoots = [
      path.join(app.getPath('home'), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh'),
      path.join(npmRoot, '@deepseek-ai', 'dsh'),
    ];
    for (const packageRoot of packageRoots) {
      dsh = await validateDshInstallation(runtime.node, packageRoot);
      if (dsh) break;
    }
  } catch (error) {
    console.error('[environment] dsh 检查失败', error);
  }
  items.push({
    name: 'dsh',
    ok: Boolean(dsh),
    detail: dsh ? `${dsh.version}（${dsh.cli}）` : `未检测到要求版本 ${DSH_REQUIRED_VERSION}`,
  });
  const pnpm = await validatePnpmInstallation(runtime);
  items.push({
    name: 'pnpm',
    ok: Boolean(pnpm),
    optional: true,
    detail: pnpm ? `${pnpm.version}（${pnpm.command}）` : '未安装（可选，不影响 Harness 运行）',
  });
  return { ok: items.filter((item) => !item.optional).every((item) => item.ok), items };
}

function createAppIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
}

function publishServiceState(state, message, details = {}) {
  currentServiceState = { state, message, ...details };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('dsh:state', currentServiceState);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function loadOfficialHarnessUi(url) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不存在');
  destroyHarnessView();

  harnessView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'harness-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const view = harnessView;
  harnessViewReady = false;
  registerSidebarShortcut(view.webContents);
  for (const eventName of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) {
    view.webContents.on(eventName, () => publishNavigationState());
  }
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  layoutHarnessView();

  const allowedOrigin = new URL(url).origin;
  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.origin === allowedOrigin) return { action: 'allow' };
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(parsed.href);
    } catch {}
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.origin === allowedOrigin) return;
      event.preventDefault();
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(parsed.href);
    } catch {
      event.preventDefault();
    }
  });
  await loadHarnessUrlWithRetry(view, url);
  if (harnessView !== view || view.webContents.isDestroyed()) throw new Error('Harness 页面加载已取消');
  harnessViewReady = true;
  view.setVisible(!modalOverlayOpen);
}

async function loadHarnessUrlWithRetry(view, url) {
  let lastError = null;
  for (let attempt = 1; attempt <= HOST_UI_LOAD_ATTEMPTS; attempt += 1) {
    if (view !== harnessView || view.webContents.isDestroyed()) {
      throw new Error('Harness 页面加载已取消');
    }
    try {
      await view.webContents.loadURL(url);
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `[desktop] Harness 页面加载失败：attempt=${attempt}/${HOST_UI_LOAD_ATTEMPTS}，`
        + `${error.message || error}`,
      );
      if (attempt < HOST_UI_LOAD_ATTEMPTS) {
        publishServiceState('connecting', `Host 已启动，正在重新连接（${attempt}/${HOST_UI_LOAD_ATTEMPTS}）…`);
        await delay(Math.min(4_000, 500 * (2 ** (attempt - 1))));
      }
    }
  }
  throw new Error(`无法加载 Harness 页面：${lastError?.message || '连接失败'}`);
}

function destroyHarnessView() {
  const view = harnessView;
  harnessView = null;
  harnessViewReady = false;
  if (!view) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  } catch {}
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch {}
}

function ensureSidebarBrowserView() {
  if (sidebarBrowserView && !sidebarBrowserView.webContents.isDestroyed()) return sidebarBrowserView;
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不存在');
  sidebarBrowserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const view = sidebarBrowserView;
  registerSidebarShortcut(view.webContents);
  view.setBackgroundColor('#ffffff');
  view.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = normalizeBrowserUrl(url);
      void view.webContents.loadURL(target);
    } catch {}
    return { action: 'deny' };
  });
  for (const eventName of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    view.webContents.on(eventName, () => {
      publishBrowserState();
      publishNavigationState();
    });
  }
  view.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) publishBrowserState({ error: `${description} (${code})`, url: validatedURL });
  });
  mainWindow.contentView.addChildView(view);
  layoutHarnessView();
  return view;
}

function destroySidebarBrowserView() {
  const view = sidebarBrowserView;
  sidebarBrowserView = null;
  if (!view) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  } catch {}
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch {}
}

function publishBrowserState(details = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = sidebarBrowserView?.webContents;
  mainWindow.webContents.send('browser:state', {
    url: contents && !contents.isDestroyed() ? contents.getURL() : '',
    title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
    loading: Boolean(contents && !contents.isDestroyed() && contents.isLoading()),
    canGoBack: Boolean(contents && !contents.isDestroyed() && canBrowserGoBack(contents)),
    canGoForward: Boolean(contents && !contents.isDestroyed() && canBrowserGoForward(contents)),
    ...details,
  });
}

function canBrowserGoBack(contents) {
  return contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.() ?? false;
}

function getNavigationContents() {
  if (
    sidebarOpen
    && sidebarActiveTool === 'browser'
    && sidebarBrowserView
    && !sidebarBrowserView.webContents.isDestroyed()
  ) return sidebarBrowserView.webContents;
  if (harnessView && !harnessView.webContents.isDestroyed()) return harnessView.webContents;
  return null;
}

function publishNavigationState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = getNavigationContents();
  mainWindow.webContents.send('navigation:state', {
    canGoBack: Boolean(contents && canBrowserGoBack(contents)),
    canGoForward: Boolean(contents && canBrowserGoForward(contents)),
    loading: Boolean(contents && contents.isLoading()),
  });
}

function canBrowserGoForward(contents) {
  return contents.navigationHistory?.canGoForward?.() ?? contents.canGoForward?.() ?? false;
}

function goBrowserBack(contents) {
  if (contents.navigationHistory?.goBack) contents.navigationHistory.goBack();
  else contents.goBack?.();
}

function goBrowserForward(contents) {
  if (contents.navigationHistory?.goForward) contents.navigationHistory.goForward();
  else contents.goForward?.();
}

function layoutHarnessView() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const sidebarWidth = getSidebarWidth();
  if (harnessView) {
    harnessView.setBounds({
      x: 0,
      y: TOP_NAVIGATION_HEIGHT,
      width: Math.max(0, width - sidebarWidth),
      height: Math.max(0, height - TOP_NAVIGATION_HEIGHT),
    });
  }
  if (sidebarBrowserView && !sidebarBrowserView.webContents.isDestroyed()) {
    const browserVisible = !modalOverlayOpen && sidebarOpen && sidebarActiveTool === 'browser';
    sidebarBrowserView.setVisible(browserVisible);
    if (browserVisible) {
      const panelWidth = getSidebarPanelWidth();
      sidebarBrowserView.setBounds({
        x: Math.max(0, width - panelWidth + SIDEBAR_RESIZE_HANDLE_WIDTH),
        y: SIDEBAR_BROWSER_TOP,
        width: Math.max(0, panelWidth - SIDEBAR_RAIL_WIDTH - SIDEBAR_RESIZE_HANDLE_WIDTH),
        height: Math.max(0, height - SIDEBAR_BROWSER_TOP),
      });
    }
  }
}

function getSidebarWidth() {
  return sidebarOpen ? getSidebarPanelWidth() : SIDEBAR_RAIL_WIDTH;
}

function getSidebarPanelWidth() {
  if (!mainWindow || mainWindow.isDestroyed()) return clampSidebarPanelWidth(sidebarPanelWidth, false);
  const [windowWidth] = mainWindow.getContentSize();
  return Math.min(
    clampSidebarPanelWidth(sidebarPanelWidth, false),
    Math.max(SIDEBAR_MIN_WIDTH, windowWidth - SIDEBAR_MAIN_MIN_WIDTH),
  );
}

function clampSidebarPanelWidth(width, respectWindow = true) {
  const numericWidth = Number(width);
  let maximum = SIDEBAR_MAX_WIDTH;
  if (respectWindow && mainWindow && !mainWindow.isDestroyed()) {
    const [windowWidth] = mainWindow.getContentSize();
    maximum = Math.min(maximum, Math.max(SIDEBAR_MIN_WIDTH, windowWidth - SIDEBAR_MAIN_MIN_WIDTH));
  }
  if (!Number.isFinite(numericWidth)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(maximum, Math.max(SIDEBAR_MIN_WIDTH, numericWidth)));
}

function publishSidebarState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('sidebar:state', {
    open: sidebarOpen,
    tool: sidebarActiveTool,
    width: getSidebarWidth(),
    panelWidth: getSidebarPanelWidth(),
    workspace: workspaceRoot,
  });
  publishNavigationState();
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  layoutHarnessView();
  publishSidebarState();
}

function registerSidebarShortcut(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const key = String(input.key).toLowerCase();
    if (input.control && input.shift && key === 's') {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    let tool = null;
    if (input.control && input.shift && key === 'g') tool = 'review';
    else if (input.control && !input.shift && (key === '`' || key === 'backquote')) tool = 'terminal';
    else if (input.control && !input.shift && key === 't') tool = 'browser';
    else if (input.control && !input.shift && key === 'p') tool = 'files';
    if (!tool) return;
    event.preventDefault();
    sidebarActiveTool = tool;
    sidebarOpen = true;
    layoutHarnessView();
    publishSidebarState();
  });
}

function startDshHost(runtime, statusMessage = '正在启动本地 Harness Host…') {
  if (dshProcess) return Promise.reject(new Error('dsh Host 已经在运行'));
  publishServiceState('starting', statusMessage);

  return new Promise((resolve, reject) => {
    let settled = false;
    let probing = false;
    let outputBuffer = '';
    const child = spawn(
      runtime.node,
      [runtime.cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
      {
        cwd: app.getPath('home'),
        env: {
          ...createRuntimeProcessEnvironment(runtime),
          FORCE_COLOR: '0',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    dshProcess = child;

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(probeTimer);
    };

    const finishReady = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      dshUrl = url;
      publishServiceState('connecting', `Host 已启动，正在连接 ${new URL(url).port}…`);
      resolve();
    };

    const verifyCandidate = async (url) => {
      if (settled) return false;
      try {
        const result = await callDshAt(url, 'session.list', {}, 2_000);
        if (!result?.ok || !Array.isArray(result.value?.items)) return false;
        finishReady(url);
        return true;
      } catch {
        return false;
      }
    };

    const probeListeningPort = async () => {
      if (settled || probing || child.exitCode !== null || !child.pid) return;
      probing = true;
      try {
        const urls = await findListeningUrls(child.pid);
        for (const url of urls) {
          if (await verifyCandidate(url)) break;
        }
      } finally {
        probing = false;
      }
    };

    const probeTimer = setInterval(() => void probeListeningPort(), 750);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('等待 dsh Host 就绪超时（300 秒）'));
      void stopDshHost();
    }, DSH_START_TIMEOUT_MS);
    setTimeout(() => void probeListeningPort(), 250);

    const consume = (chunk, source) => {
      const text = stripAnsi(chunk.toString());
      console.log(`[dsh:${source}] ${text.trimEnd()}`);
      outputBuffer = `${outputBuffer}${text}`.slice(-16_384);
      const match = outputBuffer.match(/dsh web:[^\r\n]*?(?:127\.0\.0\.1|localhost):(\d{1,5})/i);
      if (settled || !match) return;
      const port = Number(match[1]);
      if (port < 1 || port > 65_535) return;
      void verifyCandidate(`http://127.0.0.1:${port}`);
    };

    child.stdout.on('data', (chunk) => consume(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => consume(chunk, 'stderr'));
    child.once('error', (error) => {
      cleanup();
      if (dshProcess === child) dshProcess = null;
      if (!settled) {
        settled = true;
        reject(new Error(`无法启动 dsh：${error.message}`));
      } else if (!isQuitting && hostMonitoringEnabled) {
        scheduleHostRecovery(runtime, `进程错误：${error.message}`);
      }
    });
    child.once('exit', (code, signal) => {
      cleanup();
      const wasCurrentHost = dshProcess === child;
      const intentionalStop = child.pid ? intentionalHostStops.delete(child.pid) : false;
      if (wasCurrentHost) {
        dshProcess = null;
        dshUrl = null;
      }
      if (!settled) {
        settled = true;
        reject(new Error(`dsh 在就绪前退出（code=${code}, signal=${signal ?? 'none'}）`));
      } else if (!isQuitting && wasCurrentHost && !intentionalStop && hostMonitoringEnabled) {
        scheduleHostRecovery(runtime, `code=${code ?? 'none'}, signal=${signal ?? 'none'}`);
      }
    });
  });
}

function scheduleHostRecovery(runtime, reason) {
  if (isQuitting || usingExternalHost || hostRecoveryPromise) return;
  hostMonitoringEnabled = false;
  clearHostStabilityTimer();
  destroyHarnessView();
  const generation = ++hostRecoveryGeneration;
  console.error(`[host] Harness Host 异常停止，准备自动恢复：${reason}`);

  const recovery = runHostRecovery(runtime, generation, reason).finally(() => {
    if (hostRecoveryPromise === recovery) hostRecoveryPromise = null;
  });
  hostRecoveryPromise = recovery;
}

async function runHostRecovery(runtime, generation, reason) {
  let lastError = new Error(`Harness Host 已停止（${reason}）`);

  while (hostRecoveryAttempts < HOST_RECOVERY_MAX_ATTEMPTS) {
    hostRecoveryAttempts += 1;
    const attempt = hostRecoveryAttempts;
    const waitMs = Math.min(8_000, 1_000 * (2 ** (attempt - 1)));
    publishServiceState(
      'recovering',
      `Harness Host 已中断，${Math.round(waitMs / 1_000)} 秒后自动恢复（${attempt}/${HOST_RECOVERY_MAX_ATTEMPTS}）…`,
    );
    await delay(waitMs);
    if (isQuitting || generation !== hostRecoveryGeneration) return;

    try {
      await startDshHost(
        runtime,
        `正在恢复 Harness Host（${attempt}/${HOST_RECOVERY_MAX_ATTEMPTS}）…`,
      );
      if (isQuitting || generation !== hostRecoveryGeneration) {
        await stopDshHost();
        return;
      }
      await loadOfficialHarnessUi(dshUrl);
      if (isQuitting || generation !== hostRecoveryGeneration) {
        await stopDshHost();
        return;
      }
      markHostHealthy();
      publishServiceState('ready', 'DeepSeek Harness 已自动恢复');
      console.log(`[host] Harness Host 自动恢复成功，attempt=${attempt}，url=${dshUrl}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`[host] Harness Host 自动恢复失败，attempt=${attempt}：`, error);
      destroyHarnessView();
      if (dshProcess) await stopDshHost();
      if (isQuitting || generation !== hostRecoveryGeneration) return;
    }
  }

  publishServiceState(
    'error',
    `Harness Host 自动恢复失败：${lastError.message || lastError}`,
  );
  showMainWindow();
}

function markHostHealthy() {
  hostMonitoringEnabled = true;
  clearHostStabilityTimer();
  hostStabilityTimer = setTimeout(() => {
    hostRecoveryAttempts = 0;
    hostStabilityTimer = null;
    console.log('[host] Harness Host 已稳定运行，自动恢复次数已重置');
  }, HOST_RECOVERY_STABLE_MS);
  hostStabilityTimer.unref();
}

function cancelHostRecovery() {
  hostRecoveryGeneration += 1;
  hostMonitoringEnabled = false;
  clearHostStabilityTimer();
}

function clearHostStabilityTimer() {
  if (!hostStabilityTimer) return;
  clearTimeout(hostStabilityTimer);
  hostStabilityTimer = null;
}

async function findListeningUrls(pid) {
  const result = await runProcess('netstat.exe', ['-ano', '-p', 'tcp'], 5_000, false);
  if (result.code !== 0) return [];

  const ports = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match || Number(match[2]) !== pid) continue;
    const port = Number(match[1]);
    if (port >= 1 && port <= 65_535) ports.add(port);
  }
  return [...ports].map((port) => `http://127.0.0.1:${port}`);
}

async function ensureGlobalDsh(options = {}) {
  publishServiceState('installing', '正在检查电脑上的 DeepSeek Harness…');
  if (!/^@[0-9A-Za-z._-]+\/[0-9A-Za-z._-]+$/.test(DSH_PACKAGE_NAME || '')) {
    throw new Error('package.json 中的 dshRuntime.packageName 无效');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(DSH_REQUIRED_VERSION || '')) {
    throw new Error(`package.json 中的 ${DSH_PACKAGE_NAME} 版本无效`);
  }
  if (!Number.isInteger(MIN_NODE_MAJOR) || MIN_NODE_MAJOR < 20) {
    throw new Error('package.json 中的 dshRuntime.minimumNodeMajor 无效');
  }
  if (!/^\d+\.\d+\.\d+$/.test(PREFERRED_NODE_VERSION || '') ||
      !/^[0-9a-f]{64}$/i.test(PREFERRED_NODE_SHA256 || '')) {
    throw new Error('package.json 中的 Node.js 下载版本或 SHA-256 无效');
  }

  const approvedRequirements = new Set(
    Array.isArray(options.installRequirements) ? options.installRequirements : [],
  );
  let nodeRuntimes = await findNpmRuntimes();
  let npmRuntime = nodeRuntimes.find((runtime) => runtime.major >= MIN_NODE_MAJOR) || null;

  if (!npmRuntime) {
    const detectedVersion = nodeRuntimes[0]?.version;
    const winget = await findExecutable('winget.exe');
    if (!approvedRequirements.has('node')) {
      const nodeStatus = detectedVersion ? 'outdated' : 'missing';
      throw new EnvironmentRequirementsError([
        {
          id: 'node',
          name: 'Node.js / npm',
          status: nodeStatus,
          currentVersion: detectedVersion || null,
          requiredVersion: `Node.js ${PREFERRED_NODE_VERSION}（最低 v${MIN_NODE_MAJOR}）`,
          description: detectedVersion
            ? `当前 ${detectedVersion} 版本过低，DeepSeek Harness 无法运行。`
            : '电脑上未检测到可用的 Node.js 和 npm。',
          methods: [
            {
              id: 'managed',
              label: '客户端专用安装（推荐，无需管理员权限）',
            },
            ...(winget ? [{ id: 'winget', label: '通过 winget 安装系统版' }] : []),
          ],
        },
        {
          id: 'dsh',
          name: 'DeepSeek Harness',
          status: 'pending',
          currentVersion: null,
          requiredVersion: DSH_REQUIRED_VERSION,
          description: '安装 Node.js 后继续校验，并在缺失时自动安装。',
          dependsOn: ['node'],
        },
      ]);
    }
    let wingetFailure = null;

    if (options.nodeInstallMethod === 'winget' && winget) {
      publishServiceState(
        'installing',
        detectedVersion
          ? `Node.js ${detectedVersion} 版本过低，正在通过 winget 升级…`
          : '未检测到 Node.js，正在通过 winget 安装 Node.js LTS…',
      );
      const actions = detectedVersion ? ['upgrade', 'install'] : ['install'];
      let lastInstallResult = null;
      await withInstallationSession(async () => {
        for (const action of actions) {
          lastInstallResult = await runProcess(winget, [
            action, '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent',
            '--accept-package-agreements', '--accept-source-agreements',
          ], 15 * 60_000, true, true);
          if (lastInstallResult.cancelled) throw new Error('Node.js 安装已取消');
          if (isSuccessfulInstallerExit(lastInstallResult.code)) break;
        }
      });
      if (!lastInstallResult || !isSuccessfulInstallerExit(lastInstallResult.code)) {
        wingetFailure = tail(lastInstallResult?.stderr || lastInstallResult?.stdout);
        console.error(`[install] winget 安装 Node.js 失败，将使用客户端专用运行时：${wingetFailure}`);
      }
      nodeRuntimes = await findNpmRuntimes();
      npmRuntime = nodeRuntimes.find((runtime) => runtime.major >= MIN_NODE_MAJOR) || null;
    }

    if (!npmRuntime) {
      publishServiceState(
        'installing',
        winget
          ? '系统 Node.js 安装不可用，正在准备客户端专用 Node.js…'
          : '未找到 winget，正在下载客户端专用 Node.js…',
      );
      try {
        npmRuntime = await withInstallationSession(ensureManagedNodeRuntime);
      } catch (error) {
        const wingetDetail = wingetFailure ? `；winget：${wingetFailure}` : '';
        throw new Error(`Node.js 自动安装失败：${error.message || error}${wingetDetail}`);
      }
    }
  }

  let npmRoot = await getGlobalNpmRoot(npmRuntime);
  const packageRoots = [
    path.join(app.getPath('home'), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(npmRoot, '@deepseek-ai', 'dsh'),
  ];
  for (const packageRoot of packageRoots) {
    const validated = await validateDshInstallation(npmRuntime.node, packageRoot);
    if (validated) {
      return validated;
    }
  }

  if (!approvedRequirements.has('dsh')) {
    throw new EnvironmentRequirementsError([
      {
        id: 'dsh',
        name: 'DeepSeek Harness',
        status: 'missing',
        currentVersion: null,
        requiredVersion: DSH_REQUIRED_VERSION,
        description: '未检测到要求版本的 dsh，需要通过 npm 下载并安装。',
      },
    ]);
  }

  await withInstallationSession(() => installDshWithRegistryFallback(npmRuntime));

  npmRoot = await getGlobalNpmRoot(npmRuntime);
  const packageRoot = path.join(npmRoot, '@deepseek-ai', 'dsh');
  const validated = await validateDshInstallation(npmRuntime.node, packageRoot);
  if (!validated) {
    throw new Error(`dsh 安装完成，但版本或 CLI 健康检查未通过：${packageRoot}`);
  }
  return validated;
}

async function validatePnpmInstallation(runtime) {
  try {
    const npmRoot = await getGlobalNpmRoot(runtime);
    const packageRoot = path.join(npmRoot, 'pnpm');
    const packageFile = path.join(packageRoot, 'package.json');
    const command = path.join(path.dirname(npmRoot), 'pnpm.cmd');
    if (!fs.existsSync(packageFile) || !fs.existsSync(command)) return null;
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const pnpmVersion = parseNodeVersion(metadata.version);
    if (metadata.name !== 'pnpm' || !pnpmVersion) return null;
    const configuredBin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.pnpm;
    const cli = path.resolve(packageRoot, configuredBin || path.join('bin', 'pnpm.cjs'));
    if (!fs.existsSync(cli)) return null;
    const versionCheck = await runProcess(
      runtime.node,
      [cli, '--version'],
      30_000,
      false,
      false,
      createRuntimeProcessEnvironment(runtime),
    );
    const version = versionCheck.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const reportedVersion = parseNodeVersion(version);
    if (versionCheck.code !== 0 || !reportedVersion) return null;
    console.log(`[environment] pnpm 检查通过：${version} (${command})`);
    return { version, command, cli };
  } catch (error) {
    console.error('[environment] 无法校验 pnpm', error);
    return null;
  }
}

async function installDshWithRegistryFallback(runtime) {
  const registries = await getNpmRegistryCandidates(runtime);
  const failures = [];

  for (let registryIndex = 0; registryIndex < registries.length; registryIndex += 1) {
    const registry = registries[registryIndex];
    const registryLabel = formatRegistryLabel(registry);

    for (let attempt = 1; attempt <= DSH_INSTALL_ATTEMPTS_PER_REGISTRY; attempt += 1) {
      const attemptText = DSH_INSTALL_ATTEMPTS_PER_REGISTRY > 1
        ? `，第 ${attempt}/${DSH_INSTALL_ATTEMPTS_PER_REGISTRY} 次`
        : '';
      publishServiceState(
        'installing',
        `正在安装 ${DSH_NPM_SPEC}（${registryLabel}${attemptText}）…`,
      );

      const installArguments = [
        runtime.cli,
        'install', '-g', DSH_NPM_SPEC,
        `--registry=${registry}`,
        '--no-audit', '--no-fund', '--loglevel=error',
        '--fetch-retries=1',
        '--fetch-retry-mintimeout=1000',
        '--fetch-retry-maxtimeout=10000',
        '--fetch-timeout=60000',
      ];
      if (runtime.managed) installArguments.push(`--prefix=${runtime.root}`);
      if (runtime.npmMajor >= 11) {
        installArguments.push(`--allow-scripts=${DSH_ALLOWED_INSTALL_SCRIPTS.join(',')}`);
      }
      const result = await runProcess(
        runtime.node,
        installArguments,
        DSH_INSTALL_TIMEOUT_MS,
        true,
        true,
        createRuntimeProcessEnvironment(runtime),
      );
      if (result.cancelled) throw new Error('dsh 安装已取消');
      if (result.code === 0) {
        console.log(`[install] ${DSH_NPM_SPEC} 安装成功，来源：${registryLabel}`);
        return registry;
      }

      const detail = tail(result.stderr || result.stdout, 400);
      failures.push(`${registryLabel}（第 ${attempt} 次）：${detail}`);
      console.error(
        `[install] ${DSH_NPM_SPEC} 安装失败，来源：${registryLabel}，`
        + `attempt=${attempt}，code=${result.code}：${detail}`,
      );

      if (attempt < DSH_INSTALL_ATTEMPTS_PER_REGISTRY) {
        publishServiceState('installing', `${registryLabel} 安装失败，正在重试…`);
        await delay(1_000 * attempt);
      }
    }

    if (registryIndex < registries.length - 1) {
      publishServiceState('installing', `${registryLabel} 不可用，正在切换安装源…`);
    }
  }

  throw new Error(`dsh 自动安装失败，所有安装源均不可用：${tail(failures.join('\n'), 1_200)}`);
}

function createRuntimeProcessEnvironment(runtime) {
  const environment = { ...process.env };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const nodeDirectory = path.dirname(runtime.node);
  const currentPath = String(environment[pathKey] || '');
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (!entries.some((entry) => path.resolve(entry).toLowerCase() === nodeDirectory.toLowerCase())) {
    entries.unshift(nodeDirectory);
  }
  environment[pathKey] = entries.join(path.delimiter);
  return environment;
}

async function getNpmRegistryCandidates(runtime) {
  const configured = [];
  for (const key of [`${DSH_PACKAGE_SCOPE}:registry`, 'registry']) {
    const result = await runProcess(
      runtime.node,
      [runtime.cli, 'config', 'get', key],
      30_000,
      false,
    );
    if (result.code !== 0) continue;
    const registry = normalizeRegistry(result.stdout);
    if (registry) configured.push(registry);
  }

  return [...new Set([
    ...configured,
    NPM_REGISTRY_OFFICIAL,
    NPM_REGISTRY_MIRROR,
  ].map(normalizeRegistry).filter(Boolean))];
}

function normalizeRegistry(value) {
  const candidate = String(value || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!candidate || candidate === 'undefined' || candidate === 'null') return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.search = '';
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed.href;
  } catch {
    return null;
  }
}

function formatRegistryLabel(registry) {
  try {
    const parsed = new URL(registry);
    return parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`;
  } catch {
    return '未知 npm 源';
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function validateDshInstallation(node, packageRoot) {
  const packageFile = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageFile)) return null;

  try {
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (metadata.name !== DSH_PACKAGE_NAME || metadata.version !== DSH_REQUIRED_VERSION) {
      console.log(
        `[install] 忽略不匹配的 dsh：${packageRoot} `
        + `(检测到 ${metadata.version || '未知'}，需要 ${DSH_REQUIRED_VERSION})`,
      );
      return null;
    }

    const configuredBin = typeof metadata.bin === 'string'
      ? metadata.bin
      : metadata.bin?.dsh;
    const cli = path.resolve(packageRoot, configuredBin || path.join('lib', 'bin.js'));
    if (!fs.existsSync(cli)) return null;

    const versionCheck = await runProcess(node, [cli, '--version'], 30_000, false);
    const reportedVersion = versionCheck.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (versionCheck.code !== 0 || reportedVersion !== DSH_REQUIRED_VERSION) {
      console.log(
        `[install] dsh CLI 健康检查失败：${packageRoot} `
        + `(code=${versionCheck.code}, version=${reportedVersion || '未知'})`,
      );
      return null;
    }
    return { node, cli, version: reportedVersion };
  } catch (error) {
    console.error(`[install] 无法校验 dsh：${packageRoot}`, error);
    return null;
  }
}

async function getGlobalNpmRoot(runtime) {
  const argumentsList = [runtime.cli, 'root', '-g'];
  if (runtime.managed) argumentsList.push(`--prefix=${runtime.root}`);
  const result = await runProcess(runtime.node, argumentsList, 30_000);
  if (result.code !== 0) throw new Error(`无法读取 npm 全局目录：${tail(result.stderr)}`);
  const root = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!root) throw new Error('npm 未返回全局模块目录');
  return root;
}

function getManagedNodeDirectory() {
  return path.join(
    app.getPath('userData'),
    'runtime',
    `node-v${PREFERRED_NODE_VERSION}-win-x64`,
  );
}

async function ensureManagedNodeRuntime() {
  const runtimeRoot = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  cleanupStaleManagedRuntimePaths(runtimeRoot);
  const finalDirectory = getManagedNodeDirectory();
  const existing = await inspectNpmRuntimeRoot(finalDirectory);
  if (existing?.major >= MIN_NODE_MAJOR) {
    console.log(`[install] 使用客户端专用 Node.js：${existing.version} (${finalDirectory})`);
    return existing;
  }

  const archiveName = `node-v${PREFERRED_NODE_VERSION}-win-x64.zip`;
  // Expand-Archive only accepts paths whose final extension is .zip.
  const archivePath = path.join(runtimeRoot, `${archiveName}.download.zip`);
  const stagingDirectory = path.join(runtimeRoot, `extract-${randomUUID()}`);
  const extractedDirectory = path.join(
    stagingDirectory,
    `node-v${PREFERRED_NODE_VERSION}-win-x64`,
  );
  const sources = [
    `https://nodejs.org/dist/v${PREFERRED_NODE_VERSION}/${archiveName}`,
    `https://npmmirror.com/mirrors/node/v${PREFERRED_NODE_VERSION}/${archiveName}`,
  ];
  const failures = [];

  try {
    let downloaded = false;
    for (const source of sources) {
      removeManagedRuntimePath(runtimeRoot, archivePath);
      const sourceLabel = new URL(source).host;
      publishServiceState(
        'installing',
        `正在从 ${sourceLabel} 下载 Node.js ${PREFERRED_NODE_VERSION}…`,
      );
      try {
        await downloadManagedFile(source, archivePath, 10 * 60_000);
        const actualHash = await calculateFileSha256(archivePath);
        if (actualHash.toLowerCase() !== PREFERRED_NODE_SHA256.toLowerCase()) {
          throw new Error(`SHA-256 不匹配（${actualHash}）`);
        }
        console.log(`[install] Node.js 下载校验通过：${actualHash}`);
        downloaded = true;
        break;
      } catch (error) {
        if (installationCancellationRequested) throw error;
        failures.push(`${sourceLabel}：${error.message || error}`);
        console.error(`[install] Node.js 下载失败，来源：${sourceLabel}`, error);
      }
    }
    if (!downloaded) {
      throw new Error(`所有 Node.js 下载源均不可用：${tail(failures.join('\n'), 1_000)}`);
    }

    publishServiceState('installing', `正在解压 Node.js ${PREFERRED_NODE_VERSION}…`);
    fs.mkdirSync(stagingDirectory, { recursive: true });
    const powershell = await findExecutable('powershell.exe');
    if (!powershell) throw new Error('找不到 PowerShell，无法解压 Node.js');
    const extracted = await runProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', POWERSHELL_EXPAND_ARCHIVE_COMMAND, archivePath, stagingDirectory,
    ], 10 * 60_000, true, true);
    if (extracted.cancelled) throw new Error('Node.js 安装已取消');
    if (extracted.code !== 0) {
      throw new Error(`Node.js 解压失败：${tail(extracted.stderr || extracted.stdout)}`);
    }
    const extractionCandidates = [
      extractedDirectory,
      stagingDirectory,
      ...fs.readdirSync(stagingDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(stagingDirectory, entry.name)),
    ];
    let extractedRuntimeDirectory = null;
    for (const candidate of [...new Set(extractionCandidates.map((item) => path.resolve(item)))]) {
      const candidateRuntime = await inspectNpmRuntimeRoot(candidate);
      if (candidateRuntime?.major >= MIN_NODE_MAJOR) {
        extractedRuntimeDirectory = candidate;
        break;
      }
    }
    if (!extractedRuntimeDirectory) {
      const extractedEntries = fs.readdirSync(stagingDirectory).slice(0, 12).join(', ');
      throw new Error(
        `Node.js 解压完成，但找不到 node.exe/npm（解压内容：${extractedEntries || '空'}）`,
      );
    }

    removeManagedRuntimePath(runtimeRoot, finalDirectory);
    await renameManagedRuntimePath(runtimeRoot, extractedRuntimeDirectory, finalDirectory);
    const runtime = await inspectNpmRuntimeRoot(finalDirectory);
    if (!runtime || runtime.major < MIN_NODE_MAJOR) {
      throw new Error('客户端专用 Node.js 安装完成，但运行检查未通过');
    }
    console.log(`[install] 客户端专用 Node.js 安装成功：${runtime.version}`);
    return runtime;
  } finally {
    cleanupManagedRuntimePath(runtimeRoot, archivePath);
    cleanupManagedRuntimePath(runtimeRoot, stagingDirectory);
  }
}

async function downloadManagedFile(url, destination, timeoutMs) {
  const controller = new AbortController();
  managedInstallationDownloads.add(controller);
  const timeout = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs);
  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(destination, { flags: 'w' }),
    );
  } finally {
    clearTimeout(timeout);
    managedInstallationDownloads.delete(controller);
  }
}

function calculateFileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function removeManagedRuntimePath(runtimeRoot, target) {
  if (!isManagedRuntimePath(runtimeRoot, target)) return;
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: MANAGED_RUNTIME_FS_MAX_RETRIES,
    retryDelay: MANAGED_RUNTIME_FS_RETRY_DELAY_MS,
  });
}

function cleanupManagedRuntimePath(runtimeRoot, target) {
  try {
    removeManagedRuntimePath(runtimeRoot, target);
  } catch (error) {
    console.warn(`[install] 无法清理临时运行时路径，将在下次启动时重试：${target}`, error);
  }
}

function cleanupStaleManagedRuntimePaths(runtimeRoot) {
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^extract-[0-9a-f-]{36}$/i.test(entry.name)) continue;
    cleanupManagedRuntimePath(runtimeRoot, path.join(runtimeRoot, entry.name));
  }
}

function isManagedRuntimePath(runtimeRoot, target) {
  const relative = path.relative(path.resolve(runtimeRoot), path.resolve(target));
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function renameManagedRuntimePath(runtimeRoot, source, destination) {
  if (!isManagedRuntimePath(runtimeRoot, source) || !isManagedRuntimePath(runtimeRoot, destination)) {
    throw new Error('拒绝移动运行时目录之外的路径');
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const retryable = ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
      if (!retryable || attempt >= MANAGED_RUNTIME_FS_MAX_RETRIES) throw error;
      await delay(MANAGED_RUNTIME_FS_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

async function inspectNpmRuntimeRoot(root) {
  const node = path.join(root, 'node.exe');
  const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(node) || !fs.existsSync(cli)) return null;
  const versionResult = await runProcess(node, ['--version'], 10_000, false);
  const parsedVersion = parseNodeVersion(versionResult.stdout);
  if (versionResult.code !== 0 || !parsedVersion) return null;
  const npmVersionResult = await runProcess(node, [cli, '--version'], 10_000, false);
  const npmVersion = npmVersionResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const npmMajor = Number.parseInt(String(npmVersion || '').split('.')[0], 10);
  if (npmVersionResult.code !== 0 || !Number.isInteger(npmMajor)) return null;
  return {
    node,
    cli,
    root,
    managed: path.resolve(root) === path.resolve(getManagedNodeDirectory()),
    npmVersion,
    npmMajor,
    ...parsedVersion,
  };
}

async function findNpmRuntimes() {
  const npmCommands = await findExecutables('npm.cmd');
  const nodeCommands = await findExecutables('node.exe');
  const roots = [
    ...npmCommands.map((item) => path.dirname(item)),
    ...nodeCommands.map((item) => path.dirname(item)),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
    getManagedNodeDirectory(),
  ].filter(Boolean);

  const runtimes = [];
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) {
    const runtime = await inspectNpmRuntimeRoot(root);
    if (runtime) runtimes.push(runtime);
  }
  return runtimes;
}

function parseNodeVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    version: `v${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
  };
}

function isSuccessfulInstallerExit(code) {
  return code === 0 || code === 3010;
}

async function findExecutable(name) {
  return (await findExecutables(name))[0] || null;
}

async function findExecutables(name) {
  const result = await runProcess('where.exe', [name], 10_000, false);
  if (result.code !== 0) return [];
  return [...new Set(
    result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item && fs.existsSync(item)),
  )];
}

async function withInstallationSession(operation) {
  if (installationSessionDepth === 0) installationCancellationRequested = false;
  installationSessionDepth += 1;
  try {
    return await operation();
  } finally {
    installationSessionDepth = Math.max(0, installationSessionDepth - 1);
  }
}

async function terminateManagedInstallationProcesses() {
  for (const controller of managedInstallationDownloads) {
    controller.abort(new Error('安装已取消'));
  }
  const processes = [...managedInstallationProcesses];
  if (!processes.length) return;
  console.log(`[install] 正在终止 ${processes.length} 个安装进程树…`);
  await Promise.allSettled(processes.map((child) => terminateProcessTree(child)));
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return Promise.resolve();
  const pid = child.pid;
  console.log(`[install] 终止安装进程树：pid=${pid}`);
  return new Promise((resolve) => {
    let finished = false;
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    killer.once('error', () => {
      try { child.kill('SIGTERM'); } catch {}
      finish();
    });
    killer.once('exit', (code) => {
      if (code !== 0 && child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
      finish();
    });
    const timeout = setTimeout(() => {
      try { killer.kill('SIGTERM'); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      finish();
    }, 10_000);
  });
}

function runProcess(
  executable,
  args,
  timeoutMs,
  logOutput = true,
  manageInstallation = false,
  environment = process.env,
) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    if (manageInstallation) {
      managedInstallationProcesses.add(child);
      console.log(`[install] 已启动受管安装进程：${path.basename(executable)}，pid=${child.pid || 'pending'}`);
    }
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (manageInstallation) {
        managedInstallationProcesses.delete(child);
        console.log(`[install] 受管安装进程已结束：pid=${child.pid || 'unknown'}，code=${code}`);
      }
      resolve({
        code,
        stdout,
        stderr,
        cancelled: manageInstallation && installationCancellationRequested,
      });
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (logOutput) console.log(`[install] ${chunk.toString().trimEnd()}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (logOutput) console.error(`[install] ${chunk.toString().trimEnd()}`);
    });
    child.once('error', (error) => {
      stderr += error.message;
      finish(-1);
    });
    // On Windows, `exit` may fire while stdio/process handles are still being
    // released. Waiting for `close` prevents immediate runtime moves from
    // intermittently failing with EPERM/EBUSY after node.exe has exited.
    child.once('close', (code) => finish(code ?? -1));
    timer = setTimeout(() => {
      stderr += `\n执行超时（${timeoutMs}ms）`;
      if (manageInstallation) {
        void terminateProcessTree(child).finally(() => finish(-1));
      } else {
        child.kill('SIGTERM');
        finish(-1);
      }
    }, timeoutMs);
  });
}

function tail(value, length = 600) {
  return String(value || '未知错误').trim().slice(-length);
}

async function callDshAt(baseUrl, method, payload, timeoutMs = 15_000) {
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method} 请求失败：HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
    throw new Error(`${method} 返回了无效的 RPC 响应`);
  }
  return envelope.result;
}

async function findExistingHost() {
  const configured = process.env.DSH_DESKTOP_HOST?.trim();
  const candidates = [...new Set([
    configured,
    'http://127.0.0.1:3080',
  ].filter(Boolean).map((value) => value.replace(/\/$/, '')))];

  for (const candidate of candidates) {
    try {
      const result = await callDshAt(candidate, 'session.list', {}, 1_500);
      if (result?.ok && Array.isArray(result.value?.items)) return candidate;
    } catch {}
  }
  return null;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function stopDshHost() {
  const child = dshProcess;
  dshProcess = null;
  dshUrl = null;
  usingExternalHost = false;
  if (!child || child.exitCode !== null) return;
  if (child.pid) intentionalHostStops.add(child.pid);

  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (child.pid) intentionalHostStops.delete(child.pid);
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('exit', finish);
        killer.once('error', finish);
      } else {
        finish();
      }
    }, DSH_STOP_TIMEOUT_MS).unref();
  });
}
