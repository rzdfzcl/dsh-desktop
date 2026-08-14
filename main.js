'use strict';

const path = require('node:path');
const fs = require('node:fs');
const util = require('node:util');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const packageMetadata = require('./package.json');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
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
const DSH_INSTALL_ATTEMPTS_PER_REGISTRY = 2;
const DSH_INSTALL_TIMEOUT_MS = 10 * 60_000;
const NPM_REGISTRY_OFFICIAL = 'https://registry.npmjs.org/';
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com/';
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_BACKUP_COUNT = 4;
const HOST_RECOVERY_MAX_ATTEMPTS = 3;
const HOST_RECOVERY_STABLE_MS = 60_000;
const HOST_UI_LOAD_ATTEMPTS = 4;

let mainWindow = null;
let harnessView = null;
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
const managedInstallationProcesses = new Set();
const intentionalHostStops = new Set();
let currentServiceState = {
  state: 'starting',
  message: '正在启动 DeepSeek Harness…',
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  registerAppLifecycle();
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

function bootstrapHarness() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = runBootstrapHarness().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

async function runBootstrapHarness() {
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
      const installedDsh = await ensureGlobalDsh();
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
      height: 38,
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
    publishServiceState(currentServiceState.state, currentServiceState.message);
  });
  mainWindow.on('resize', layoutHarnessView);
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
      ? runtimes.map((runtime) => `${runtime.version} (${runtime.node})`).join('; ')
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
    `日志文件：${logFilePath || '未初始化'}`,
    `生成时间：${new Date().toISOString()}`,
  ].join('\r\n');
}

function createAppIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
}

function publishServiceState(state, message) {
  currentServiceState = { state, message };
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const view = harnessView;
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
  await view.webContents.insertCSS(`
    html::before {
      -webkit-app-region: drag;
      content: "";
      position: fixed;
      z-index: 2147483647;
      top: 0;
      left: 280px;
      right: 145px;
      height: 32px;
    }
  `);
  await view.webContents.executeJavaScript(`
    (() => {
      const shiftSessionLog = () => {
        const controls = document.querySelectorAll('button, a, [role="button"]');
        for (const control of controls) {
          const label = [
            control.textContent,
            control.getAttribute('aria-label'),
            control.getAttribute('title'),
          ].filter(Boolean).join(' ').trim();
          if (!/session\\s*log/i.test(label)) continue;
          control.style.setProperty('position', 'relative', 'important');
          control.style.setProperty('top', '28px', 'important');
          control.style.setProperty('z-index', '2147483646', 'important');
        }
      };

      shiftSessionLog();
      new MutationObserver(shiftSessionLog).observe(document.body, {
        childList: true,
        subtree: true,
      });
    })();
  `);
  view.setVisible(true);
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
  if (!view) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  } catch {}
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch {}
}

function layoutHarnessView() {
  if (!mainWindow || !harnessView) return;
  const [width, height] = mainWindow.getContentSize();
  harnessView.setBounds({
    x: 0,
    y: 0,
    width: Math.max(0, width),
    height: Math.max(0, height),
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
          ...process.env,
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

async function ensureGlobalDsh() {
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

  let nodeRuntimes = await findNpmRuntimes();
  let npmRuntime = nodeRuntimes.find((runtime) => runtime.major >= MIN_NODE_MAJOR) || null;

  if (!npmRuntime) {
    const detectedVersion = nodeRuntimes[0]?.version;
    publishServiceState(
      'installing',
      detectedVersion
        ? `Node.js ${detectedVersion} 版本过低，正在升级到 LTS…`
        : '未检测到 Node.js，正在通过 winget 安装 Node.js LTS…',
    );
    const winget = await findExecutable('winget.exe');
    if (!winget) {
      throw new Error(
        detectedVersion
          ? `当前 Node.js ${detectedVersion} 低于最低要求 v${MIN_NODE_MAJOR}，且找不到 winget；请安装 Node.js 24 LTS`
          : '电脑上未安装 Node.js/npm，且找不到 winget；请先安装 Node.js 24 LTS',
      );
    }

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
      throw new Error(`Node.js 自动安装失败：${tail(lastInstallResult?.stderr || lastInstallResult?.stdout)}`);
    }

    nodeRuntimes = await findNpmRuntimes();
    npmRuntime = nodeRuntimes.find((runtime) => runtime.major >= MIN_NODE_MAJOR) || null;
    if (!npmRuntime) {
      const currentVersion = nodeRuntimes[0]?.version;
      throw new Error(
        currentVersion
          ? `Node.js 已安装，但当前检测到的 ${currentVersion} 仍低于最低要求 v${MIN_NODE_MAJOR}；请重启客户端`
          : 'Node.js 已安装，但暂时找不到可用的 npm；请重启客户端',
      );
    }
  }

  let npmRoot = await getGlobalNpmRoot(npmRuntime);
  const packageRoots = [
    path.join(app.getPath('home'), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(npmRoot, '@deepseek-ai', 'dsh'),
  ];
  for (const packageRoot of packageRoots) {
    const validated = await validateDshInstallation(npmRuntime.node, packageRoot);
    if (validated) return validated;
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

      const result = await runProcess(runtime.node, [
        runtime.cli,
        'install', '-g', DSH_NPM_SPEC,
        `--registry=${registry}`,
        '--no-audit', '--no-fund', '--loglevel=error',
        '--fetch-retries=1',
        '--fetch-retry-mintimeout=1000',
        '--fetch-retry-maxtimeout=10000',
        '--fetch-timeout=60000',
      ], DSH_INSTALL_TIMEOUT_MS, true, true);
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
  const result = await runProcess(runtime.node, [runtime.cli, 'root', '-g'], 30_000);
  if (result.code !== 0) throw new Error(`无法读取 npm 全局目录：${tail(result.stderr)}`);
  const root = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!root) throw new Error('npm 未返回全局模块目录');
  return root;
}

async function findNpmRuntimes() {
  const npmCommands = await findExecutables('npm.cmd');
  const nodeCommands = await findExecutables('node.exe');
  const roots = [
    ...npmCommands.map((item) => path.dirname(item)),
    ...nodeCommands.map((item) => path.dirname(item)),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
  ].filter(Boolean);

  const runtimes = [];
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) {
    const node = path.join(root, 'node.exe');
    const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(node) || !fs.existsSync(cli)) continue;

    const versionResult = await runProcess(node, ['--version'], 10_000, false);
    const parsedVersion = parseNodeVersion(versionResult.stdout);
    if (versionResult.code !== 0 || !parsedVersion) continue;
    runtimes.push({ node, cli, ...parsedVersion });
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

function runProcess(executable, args, timeoutMs, logOutput = true, manageInstallation = false) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    child.once('exit', (code) => finish(code ?? -1));
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
