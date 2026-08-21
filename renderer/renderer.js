'use strict';

const statusText = document.querySelector('#status-text');
const splash = document.querySelector('.splash');
const retryButton = document.querySelector('#retry-button');
const openLogsButton = document.querySelector('#open-logs-button');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics-button');
const actionFeedback = document.querySelector('#action-feedback');
const requirementsList = document.querySelector('#requirements-list');
const installButton = document.querySelector('#install-button');
const appSidebar = document.querySelector('#app-sidebar');
const sidebarResizer = document.querySelector('#sidebar-resizer');
const sidebarToggle = document.querySelector('#sidebar-toggle');
const sidebarToolTitle = document.querySelector('#sidebar-tool-title');
const workspacePath = document.querySelector('#workspace-path');
const chooseWorkspaceButton = document.querySelector('#choose-workspace');
const sidebarToast = document.querySelector('#sidebar-toast');
const reviewSummary = document.querySelector('#review-summary');
const reviewSourceSelect = document.querySelector('#review-source');
const reviewTree = document.querySelector('#review-tree');
const reviewDetailTitle = document.querySelector('#review-detail-title');
const reviewDiff = document.querySelector('#review-diff');
const refreshReviewButton = document.querySelector('#refresh-review');
const terminalConsole = document.querySelector('#terminal-console');
const terminalInput = document.querySelector('#terminal-input');
const terminalOutput = document.querySelector('#terminal-output');
const terminalPrompt = document.querySelector('#terminal-prompt');
const clearTerminalButton = document.querySelector('#clear-terminal');
const browserForm = document.querySelector('#browser-form');
const browserAddress = document.querySelector('#browser-address');
const browserPlaceholder = document.querySelector('#browser-placeholder');
const fileTree = document.querySelector('#file-tree');
const filePreviewName = document.querySelector('#file-preview-name');
const filePreview = document.querySelector('#file-preview');
const refreshFilesButton = document.querySelector('#refresh-files');
const refreshPluginsButton = document.querySelector('#refresh-plugins');
const pluginProfilePath = document.querySelector('#plugin-profile-path');
const pluginInstallForm = document.querySelector('#plugin-install-form');
const pluginPackageInput = document.querySelector('#plugin-package-input');
const pluginInstallButton = document.querySelector('#plugin-install-button');
const pluginOperationStatus = document.querySelector('#plugin-operation-status');
const pluginFilter = document.querySelector('#plugin-filter');
const pluginFilterInput = document.querySelector('#plugin-filter-input');
const pluginFilterCount = document.querySelector('#plugin-filter-count');
const pluginList = document.querySelector('#plugin-list');
const pluginRestartBar = document.querySelector('#plugin-restart-bar');
const pluginRestartButton = document.querySelector('#plugin-restart-button');
const environmentDialog = document.querySelector('#environment-dialog');
const environmentDialogPanel = document.querySelector('#environment-dialog-panel');
const environmentDialogIcon = document.querySelector('#environment-dialog-icon');
const environmentDialogSummary = document.querySelector('#environment-dialog-summary');
const environmentDialogList = document.querySelector('#environment-dialog-list');
const environmentDialogClose = document.querySelector('#environment-dialog-close');
const environmentDialogDone = document.querySelector('#environment-dialog-done');
const dshVersionDialog = document.querySelector('#dsh-version-dialog');
const dshVersionDialogPanel = document.querySelector('#dsh-version-dialog-panel');
const dshVersionDialogSummary = document.querySelector('#dsh-version-dialog-summary');
const dshVersionDialogClose = document.querySelector('#dsh-version-dialog-close');
const dshVersionDialogDone = document.querySelector('#dsh-version-dialog-done');
const dshCurrentVersion = document.querySelector('#dsh-current-version');
const dshVersionSelect = document.querySelector('#dsh-version-select');
const dshUpdateButton = document.querySelector('#dsh-update-button');
const dshBackupList = document.querySelector('#dsh-backup-list');
const dshVersionFeedback = document.querySelector('#dsh-version-feedback');
const topNavigation = document.querySelector('#top-navigation');
const harnessServiceStatus = document.querySelector('#harness-service-status');
const harnessStatusLabel = document.querySelector('#harness-status-label');
const topMenuButtons = [...document.querySelectorAll('[data-top-menu]')];
const topMenuPopovers = [...document.querySelectorAll('[data-top-menu-popover]')];
const topActionButtons = [...document.querySelectorAll('[data-top-action]')];

const toolTitles = { review: '审阅', terminal: '终端', browser: '浏览器', files: '文件', plugins: '插件管理' };
const harnessStateLabels = {
  starting: '启动中',
  connecting: '连接中',
  installing: '安装中',
  ready: '已连接',
  requirements: '需安装',
  error: '错误',
};
const SIDEBAR_DEFAULT_WIDTH = 420;
const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 720;
const SIDEBAR_MAIN_MIN_WIDTH = 480;
let sidebarOpen = false;
let sidebarPanelWidth = SIDEBAR_DEFAULT_WIDTH;
let activeTool = 'review';
let currentWorkspace = '';
let sidebarToastTimer = null;
let terminalBusy = false;
let terminalHistoryIndex = 0;
const terminalHistory = [];
const loadedTools = new Set();
const collapsedDirectories = new Set();
const collapsedReviewDirectories = new Set();
let activeTopMenu = null;
let lastContentFocus = null;
let environmentDialogPreviousFocus = null;
let dshVersionDialogPreviousFocus = null;
let dshVersionDialogBusy = false;
let environmentCheckSequence = 0;
let reviewSourcePreference = 'auto';
let activeReviewSource = null;
let reviewLoadSequence = 0;
let reviewDiffSequence = 0;
let fileLoadSequence = 0;
let pluginOperationBusy = false;
let pluginListState = { profileRoot: '', plugins: [] };
let pluginFilterQuery = '';
const expandedPluginNames = new Set();

window.desktop.dsh.onState(({ state, message, requirements = [] }) => {
  statusText.textContent = message;
  splash.dataset.state = state;
  harnessServiceStatus.dataset.state = state;
  harnessStatusLabel.textContent = `Harness ${harnessStateLabels[state] || state}`;
  harnessServiceStatus.title = message;
  harnessServiceStatus.setAttribute('aria-label', `Harness 服务：${harnessStateLabels[state] || state}。${message}`);
  retryButton.disabled = state !== 'error';
  if (state === 'requirements') {
    renderRequirements(requirements);
    actionFeedback.textContent = '';
  } else {
    requirementsList.replaceChildren();
  }
  if (state !== 'error' && state !== 'requirements') actionFeedback.textContent = '';
});

window.desktop.sidebar.onState(({ open, tool, workspace, panelWidth }) => {
  applySidebarState(open, tool, workspace, panelWidth);
});
window.desktop.workspace.onChanged((change) => applyWorkspaceChange(change));
window.desktop.theme.onChanged((theme) => applyHarnessTheme(theme));

window.desktop.navigation.onMenuAction((action) => void runTopAction(action));
window.desktop.navigation.onMenuClosed(() => resetTopMenuState());
window.desktop.terminal.onOutput(({ text }) => {
  if (terminalBusy && text) appendTerminal(text);
});

document.addEventListener('focusin', (event) => {
  if (!topNavigation.contains(event.target)) lastContentFocus = event.target;
});

for (const button of topMenuButtons) {
  button.addEventListener('click', () => {
    if (activeTopMenu === button.dataset.topMenu) closeTopMenu();
    else void openTopMenu(button.dataset.topMenu, button);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    void openTopMenu(button.dataset.topMenu, button);
  });
}

for (const button of topActionButtons) {
  button.addEventListener('click', () => void runTopAction(button.dataset.topAction));
}

document.addEventListener('pointerdown', (event) => {
  if (activeTopMenu && !topNavigation.contains(event.target)) closeTopMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !activeTopMenu) return;
  event.preventDefault();
  closeTopMenu(true);
});

async function openTopMenu(menu, button) {
  activeTopMenu = menu;
  for (const button of topMenuButtons) {
    button.setAttribute('aria-expanded', String(button.dataset.topMenu === menu));
  }
  for (const popover of topMenuPopovers) popover.hidden = true;
  const bounds = button.getBoundingClientRect();
  const result = await window.desktop.navigation.showMenu(menu, { x: bounds.left, y: bounds.bottom });
  if (!result?.ok) {
    resetTopMenuState();
    showSidebarToast(result?.error || '无法打开菜单');
  }
}

function closeTopMenu(restoreMenuFocus = false) {
  const menu = activeTopMenu;
  void window.desktop.navigation.closeMenu();
  resetTopMenuState();
  if (restoreMenuFocus && menu) document.querySelector(`[data-top-menu="${menu}"]`)?.focus();
}

function resetTopMenuState() {
  activeTopMenu = null;
  for (const button of topMenuButtons) button.setAttribute('aria-expanded', 'false');
  for (const popover of topMenuPopovers) popover.hidden = true;
}

async function runNavigationAction(action) {
  const result = await window.desktop.navigation.action(action);
  if (!result?.ok) showSidebarToast(result?.error || '页面操作失败');
}

async function runTopAction(action) {
  resetTopMenuState();
  if (action === 'choose-workspace') return chooseWorkspace();
  if (action === 'open-logs') return openLogs();
  if (action === 'check-environment') {
    const requestId = ++environmentCheckSequence;
    showEnvironmentDialogLoading();
    let result;
    try {
      result = await window.desktop.dsh.checkEnvironment();
    } catch (error) {
      result = { ok: false, error: error.message || String(error) };
    }
    if (requestId !== environmentCheckSequence) return result;
    if (!Array.isArray(result?.items)) {
      renderEnvironmentDialog({
        ok: false,
        error: result?.error || '无法检查运行环境',
        items: [{ name: '环境检查', ok: false, detail: result?.error || '无法检查运行环境' }],
      });
      return result;
    }
    renderEnvironmentDialog(result);
    return result;
  }
  if (action === 'manage-dsh-version') return openDshVersionDialog();
  if (action === 'copy-diagnostics') return copyDiagnostics();
  if (action === 'reload') return runNavigationAction('reload');
  if (action === 'restart-harness') {
    const result = await window.desktop.dsh.restart();
    if (!result?.ok) showSidebarToast(result?.error || 'Harness 服务重启失败');
    return result;
  }
  if (action === 'toggle-sidebar') return window.desktop.sidebar.setOpen(!sidebarOpen);
  if (action.startsWith('tool-')) {
    return toggleSidebarTool(action.slice(5));
  }
  if (['copy', 'paste', 'select-all'].includes(action)) {
    if (lastContentFocus?.isConnected && typeof lastContentFocus.focus === 'function') lastContentFocus.focus();
    const result = await window.desktop.navigation.edit(action);
    if (!result?.ok) showSidebarToast(result?.error || '编辑操作失败');
  }
}

function showEnvironmentDialogLoading() {
  if (environmentDialog.hidden) environmentDialogPreviousFocus = document.activeElement;
  environmentDialog.dataset.status = 'loading';
  environmentDialog.setAttribute('aria-busy', 'true');
  environmentDialogIcon.textContent = '…';
  environmentDialogSummary.textContent = '正在检查运行环境…';
  const loading = document.createElement('div');
  loading.className = 'environment-dialog-loading';
  loading.textContent = '正在检测 Node.js、npm、dsh 与可选工具…';
  environmentDialogList.replaceChildren(loading);
  environmentDialogDone.disabled = true;
  environmentDialog.hidden = false;
  document.body.classList.add('has-modal-open');
  environmentDialogPanel.focus();
  void window.desktop.ui.setModalOpen(true);
}

function renderEnvironmentDialog(report) {
  environmentDialog.dataset.status = report.ok ? 'ready' : 'warning';
  environmentDialog.setAttribute('aria-busy', 'false');
  environmentDialogIcon.textContent = report.ok ? '✓' : '!';
  const failedCount = report.items.filter((item) => !item.optional && !item.ok).length;
  environmentDialogSummary.textContent = report.error
    ? '检查失败，请稍后重试'
    : report.ok
      ? 'Node.js、npm 与 dsh 均已就绪'
      : `发现 ${failedCount} 项必需环境需要处理`;
  const rows = report.items.map((item) => {
    const row = document.createElement('article');
    row.className = 'environment-item';
    row.dataset.ok = String(Boolean(item.ok));
    row.dataset.optional = String(Boolean(item.optional));
    const state = document.createElement('span');
    state.className = 'environment-item-state';
    state.textContent = item.ok ? '✓' : item.optional ? '—' : '!';
    const content = document.createElement('div');
    content.className = 'environment-item-content';
    const heading = document.createElement('div');
    heading.className = 'environment-item-heading';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const badge = document.createElement('span');
    badge.textContent = item.optional ? (item.ok ? '可选 · 已安装' : '可选') : item.ok ? '正常' : '需处理';
    const detail = document.createElement('div');
    detail.className = 'environment-item-detail';
    detail.textContent = item.detail;
    heading.append(name, badge);
    content.append(heading, detail);
    row.append(state, content);
    return row;
  });
  environmentDialogList.replaceChildren(...rows);
  environmentDialogDone.disabled = false;
}

function closeEnvironmentDialog() {
  if (environmentDialog.hidden) return;
  environmentCheckSequence += 1;
  environmentDialog.hidden = true;
  document.body.classList.remove('has-modal-open');
  void window.desktop.ui.setModalOpen(false);
  if (environmentDialogPreviousFocus?.isConnected) environmentDialogPreviousFocus.focus();
  environmentDialogPreviousFocus = null;
}

async function openDshVersionDialog() {
  if (dshVersionDialog.hidden) dshVersionDialogPreviousFocus = document.activeElement;
  dshVersionDialog.hidden = false;
  dshVersionDialog.setAttribute('aria-busy', 'true');
  dshVersionDialogSummary.textContent = '正在读取 npm 版本和本地回退点…';
  dshCurrentVersion.textContent = '读取中…';
  dshVersionFeedback.textContent = '';
  dshVersionSelect.replaceChildren(new Option('正在读取…', ''));
  dshVersionSelect.disabled = true;
  dshUpdateButton.disabled = true;
  dshBackupList.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'environment-dialog-loading',
    textContent: '正在读取备份…',
  }));
  document.body.classList.add('has-modal-open');
  dshVersionDialogPanel.focus();
  void window.desktop.ui.setModalOpen(true);
  try {
    const result = await window.desktop.dsh.getVersionState();
    renderDshVersionState(result);
  } catch (error) {
    renderDshVersionState({ ok: false, error: error.message || String(error), backups: [], availableVersions: [] });
  }
}

function renderDshVersionState(state) {
  const current = state?.currentVersion || state?.activeVersion || '未安装';
  dshVersionDialog.setAttribute('aria-busy', 'false');
  dshCurrentVersion.textContent = current;
  dshVersionDialogSummary.textContent = state?.error
    ? state.error
    : state?.catalogError
      ? `当前 ${current}，无法读取最新版本：${state.catalogError}`
      : `当前 ${current}，可从下方选择版本更新`;

  const updateVersions = (Array.isArray(state?.availableVersions) ? state.availableVersions : [])
    .filter((version) => compareDshVersions(version, current) > 0);
  dshVersionSelect.replaceChildren();
  if (!updateVersions.length) {
    dshVersionSelect.append(new Option('暂无可用更新', ''));
    dshVersionSelect.disabled = true;
    dshUpdateButton.disabled = true;
  } else {
    for (const version of updateVersions) dshVersionSelect.append(new Option(version, version));
    dshVersionSelect.disabled = false;
    dshUpdateButton.disabled = dshVersionDialogBusy;
  }

  const backups = Array.isArray(state?.backups) ? state.backups : [];
  if (!backups.length) {
    dshBackupList.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'environment-dialog-loading',
      textContent: '暂无回退点。完成一次更新后会自动创建。',
    }));
  } else {
    dshBackupList.replaceChildren(...backups.map((backup) => {
      const row = document.createElement('div');
      row.className = 'dsh-backup-row';
      const label = document.createElement('span');
      label.textContent = backup.version;
      const date = document.createElement('small');
      date.textContent = backup.createdAt ? new Date(backup.createdAt).toLocaleString() : '';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '回退';
      button.disabled = dshVersionDialogBusy || backup.version === current;
      button.addEventListener('click', () => void rollbackDshVersion(backup.version));
      row.append(label, date, button);
      return row;
    }));
  }
}

function compareDshVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''] : [0, 0, 0, ''];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  if (!a[3] && b[3]) return 1;
  if (a[3] && !b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

async function updateDshVersion() {
  const version = dshVersionSelect.value;
  if (!version || dshVersionDialogBusy) return;
  await runDshVersionChange('update', version);
}

async function rollbackDshVersion(version) {
  if (dshVersionDialogBusy) return;
  await runDshVersionChange('rollback', version);
}

async function runDshVersionChange(action, version) {
  dshVersionDialogBusy = true;
  dshUpdateButton.disabled = true;
  dshVersionSelect.disabled = true;
  dshVersionFeedback.dataset.state = 'loading';
  dshVersionFeedback.textContent = action === 'update'
    ? `正在更新到 ${version}，请稍候…`
    : `正在回退到 ${version}，请稍候…`;
  let refreshedState = null;
  try {
    const result = action === 'update'
      ? await window.desktop.dsh.update(version)
      : await window.desktop.dsh.rollback(version);
    if (!result?.ok) {
      dshVersionFeedback.dataset.state = 'error';
      dshVersionFeedback.textContent = result?.error || '版本切换失败';
    } else {
      dshVersionFeedback.dataset.state = 'success';
      dshVersionFeedback.textContent = `已切换到 ${version}`;
    }
    if (result?.state) {
      refreshedState = result.state;
      renderDshVersionState(result.state);
    }
    else {
      const state = await window.desktop.dsh.getVersionState();
      refreshedState = state;
      renderDshVersionState(state);
    }
  } catch (error) {
    dshVersionFeedback.dataset.state = 'error';
    dshVersionFeedback.textContent = error.message || String(error);
  } finally {
    dshVersionDialogBusy = false;
    if (refreshedState) renderDshVersionState(refreshedState);
    if (!dshVersionDialog.hidden) {
      dshVersionSelect.disabled = !dshVersionSelect.options.length || !dshVersionSelect.value;
      dshUpdateButton.disabled = dshVersionSelect.disabled;
    }
  }
}

function closeDshVersionDialog() {
  if (dshVersionDialog.hidden || dshVersionDialogBusy) return;
  dshVersionDialog.hidden = true;
  document.body.classList.remove('has-modal-open');
  void window.desktop.ui.setModalOpen(false);
  if (dshVersionDialogPreviousFocus?.isConnected) dshVersionDialogPreviousFocus.focus();
  dshVersionDialogPreviousFocus = null;
}

environmentDialogClose.addEventListener('click', closeEnvironmentDialog);
environmentDialogDone.addEventListener('click', closeEnvironmentDialog);
environmentDialog.addEventListener('pointerdown', (event) => {
  if (event.target === environmentDialog) closeEnvironmentDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dshVersionDialog.hidden) {
    event.preventDefault();
    closeDshVersionDialog();
    return;
  }
  if (event.key !== 'Escape' || environmentDialog.hidden) return;
  event.preventDefault();
  closeEnvironmentDialog();
});

dshVersionDialogClose.addEventListener('click', closeDshVersionDialog);
dshVersionDialogDone.addEventListener('click', closeDshVersionDialog);
dshVersionDialog.addEventListener('pointerdown', (event) => {
  if (event.target === dshVersionDialog) closeDshVersionDialog();
});
dshUpdateButton.addEventListener('click', () => void updateDshVersion());

void initializeSidebar();

function applyHarnessTheme(theme) {
  const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.harnessTheme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;
}

async function initializeSidebar() {
  const result = await window.desktop.sidebar.getState();
  if (!result?.ok) return;
  let initialPanelWidth = result.panelWidth;
  const savedWidth = Number(window.localStorage.getItem('desktop.sidebar.width'));
  if (Number.isFinite(savedWidth) && savedWidth >= SIDEBAR_MIN_WIDTH && savedWidth !== result.panelWidth) {
    const widthResult = await window.desktop.sidebar.setWidth(savedWidth);
    if (widthResult?.ok) initialPanelWidth = widthResult.panelWidth;
  }
  const savedTool = window.localStorage.getItem('desktop.sidebar.tool');
  const desiredTool = Object.hasOwn(toolTitles, savedTool) ? savedTool : result.tool;
  if (desiredTool && desiredTool !== result.tool) {
    await window.desktop.sidebar.setTool(desiredTool, { open: false });
  }
  applySidebarState(result.open, desiredTool || result.tool, result.workspace, initialPanelWidth);
  document.body.dataset.sidebarInitialized = 'true';
}

sidebarToggle.addEventListener('click', () => {
  void window.desktop.sidebar.setOpen(!sidebarOpen);
});

for (const button of document.querySelectorAll('[data-sidebar-tool]')) {
  button.addEventListener('click', () => void toggleSidebarTool(button.dataset.sidebarTool));
}

async function toggleSidebarTool(tool) {
  if (!Object.hasOwn(toolTitles, tool)) return;
  if (sidebarOpen && activeTool === tool) {
    return window.desktop.sidebar.setOpen(false);
  }
  return window.desktop.sidebar.setTool(tool);
}

function applySidebarState(open, tool = activeTool, workspace = currentWorkspace, panelWidth = sidebarPanelWidth) {
  sidebarOpen = Boolean(open);
  applySidebarWidth(panelWidth);
  if (Object.hasOwn(toolTitles, tool)) activeTool = tool;
  if (workspace) currentWorkspace = workspace;
  appSidebar.dataset.open = String(sidebarOpen);
  appSidebar.dataset.tool = activeTool;
  document.body.dataset.sidebarOpen = String(sidebarOpen);
  window.localStorage.setItem('desktop.sidebar.tool', activeTool);
  sidebarToggle.setAttribute('aria-expanded', String(sidebarOpen));
  sidebarToggle.setAttribute('aria-label', sidebarOpen ? '收起侧边栏' : '展开侧边栏');
  sidebarToolTitle.textContent = toolTitles[activeTool];
  workspacePath.textContent = activeTool === 'plugins'
    ? 'DeepSeek Harness · web profile'
    : currentWorkspace || '未选择工作区';
  workspacePath.title = activeTool === 'plugins' ? '管理 web profile 的 npm 插件' : currentWorkspace;
  chooseWorkspaceButton.hidden = activeTool === 'plugins';
  terminalPrompt.textContent = `PS ${currentWorkspace || ''}>`;
  for (const button of document.querySelectorAll('[data-sidebar-tool]')) {
    button.classList.toggle('is-active', button.dataset.sidebarTool === activeTool);
  }
  for (const panel of document.querySelectorAll('[data-tool-panel]')) {
    panel.classList.toggle('is-active', panel.dataset.toolPanel === activeTool);
  }
  if (sidebarOpen) void loadActiveTool();
}

function applySidebarWidth(width) {
  const maximum = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - SIDEBAR_MAIN_MIN_WIDTH));
  const numericWidth = Number(width);
  sidebarPanelWidth = Math.round(Math.min(maximum, Math.max(SIDEBAR_MIN_WIDTH, Number.isFinite(numericWidth) ? numericWidth : SIDEBAR_DEFAULT_WIDTH)));
  document.documentElement.style.setProperty('--sidebar-open-width', `${sidebarPanelWidth}px`);
  sidebarResizer.setAttribute('aria-valuenow', String(sidebarPanelWidth));
  sidebarResizer.setAttribute('aria-valuemax', String(maximum));
}

let sidebarResizePointer = null;
let sidebarResizeFrame = null;
let pendingSidebarWidth = null;

sidebarResizer.addEventListener('pointerdown', (event) => {
  if (!sidebarOpen || event.button !== 0) return;
  event.preventDefault();
  sidebarResizePointer = event.pointerId;
  sidebarResizer.setPointerCapture(event.pointerId);
  document.body.classList.add('is-resizing-sidebar');
});

sidebarResizer.addEventListener('pointermove', (event) => {
  if (sidebarResizePointer !== event.pointerId) return;
  scheduleSidebarWidth(window.innerWidth - event.clientX);
});

sidebarResizer.addEventListener('pointerup', finishSidebarResize);
sidebarResizer.addEventListener('pointercancel', finishSidebarResize);
sidebarResizer.addEventListener('lostpointercapture', finishSidebarResize);

sidebarResizer.addEventListener('dblclick', () => {
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH, true);
});

sidebarResizer.addEventListener('keydown', (event) => {
  let width = null;
  if (event.key === 'ArrowLeft') width = sidebarPanelWidth + 20;
  else if (event.key === 'ArrowRight') width = sidebarPanelWidth - 20;
  else if (event.key === 'Home') width = SIDEBAR_MIN_WIDTH;
  else if (event.key === 'End') width = SIDEBAR_MAX_WIDTH;
  if (width === null) return;
  event.preventDefault();
  setSidebarWidth(width, true);
});

function scheduleSidebarWidth(width) {
  applySidebarWidth(width);
  pendingSidebarWidth = sidebarPanelWidth;
  if (sidebarResizeFrame !== null) return;
  sidebarResizeFrame = window.requestAnimationFrame(() => {
    sidebarResizeFrame = null;
    if (pendingSidebarWidth === null) return;
    void window.desktop.sidebar.setWidth(pendingSidebarWidth);
    pendingSidebarWidth = null;
  });
}

function finishSidebarResize(event) {
  if (sidebarResizePointer === null) return;
  if (event.pointerId !== undefined && event.pointerId !== sidebarResizePointer) return;
  sidebarResizePointer = null;
  document.body.classList.remove('is-resizing-sidebar');
  window.localStorage.setItem('desktop.sidebar.width', String(sidebarPanelWidth));
  void window.desktop.sidebar.setWidth(sidebarPanelWidth);
}

function setSidebarWidth(width, persist) {
  applySidebarWidth(width);
  if (persist) window.localStorage.setItem('desktop.sidebar.width', String(sidebarPanelWidth));
  void window.desktop.sidebar.setWidth(sidebarPanelWidth);
}

async function loadActiveTool(force = false) {
  if (activeTool === 'terminal') focusTerminalInput();
  if (activeTool === 'browser') browserAddress.focus();
  if (!force && loadedTools.has(activeTool)) return;
  if (activeTool === 'review') await loadReview();
  if (activeTool === 'files') await loadFiles();
  if (activeTool === 'plugins') await loadPlugins();
  loadedTools.add(activeTool);
}

chooseWorkspaceButton.addEventListener('click', () => void chooseWorkspace());

async function chooseWorkspace() {
  const result = await window.desktop.workspace.choose();
  if (!result?.ok) return;
  applyWorkspaceChange({ ...result, source: 'manual' });
}

function normalizeWorkspaceForComparison(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}

function applyWorkspaceChange(change) {
  if (!change?.path || normalizeWorkspaceForComparison(change.path) === normalizeWorkspaceForComparison(currentWorkspace)) return;
  currentWorkspace = change.path;
  collapsedDirectories.clear();
  collapsedReviewDirectories.clear();
  reviewSourcePreference = 'auto';
  reviewSourceSelect.value = 'auto';
  reviewLoadSequence += 1;
  reviewDiffSequence += 1;
  fileLoadSequence += 1;
  loadedTools.delete('review');
  loadedTools.delete('files');
  applySidebarState(sidebarOpen, activeTool, change.path, sidebarPanelWidth);
  const prefix = change.source === 'harness' ? '已跟随 Harness 切换工作区' : '已切换工作区';
  showSidebarToast(`${prefix}：${change.name || change.path.split(/[\\/]/).filter(Boolean).at(-1)}`);
}

refreshReviewButton.addEventListener('click', () => void loadReview());
reviewSourceSelect.addEventListener('change', () => {
  reviewSourcePreference = reviewSourceSelect.value;
  collapsedReviewDirectories.clear();
  void loadReview();
});

async function loadReview() {
  const requestId = ++reviewLoadSequence;
  reviewDiffSequence += 1;
  reviewSummary.textContent = '正在检查…';
  reviewTree.innerHTML = `<div class="empty-state">${reviewSourcePreference === 'auto'
    ? '正在自动识别 Git / SVN 工作区…'
    : `正在读取 ${reviewSourcePreference === 'git' ? 'Git' : 'SVN'} 工作区…`}</div>`;
  reviewDetailTitle.textContent = '选择文件以查看变更详情';
  reviewDiff.textContent = '请从上方选择一个变更文件';
  reviewDiff.classList.add('empty-state');
  const result = await window.desktop.review.get(reviewSourcePreference);
  if (requestId !== reviewLoadSequence) return;
  if (!result?.ok) {
    reviewSummary.textContent = '无法审阅';
    activeReviewSource = null;
    renderReviewTreeMessage(result?.error || '无法识别 Git 或 SVN 工作区');
    reviewDiff.textContent = '请选择 Git 或 SVN 工作区，或在上方手动切换版本控制类型';
    return;
  }
  activeReviewSource = result.source;
  const autoOption = reviewSourceSelect.querySelector('option[value="auto"]');
  autoOption.textContent = result.detectedSource
    ? `自动（${result.detectedSource === 'git' ? 'Git' : 'SVN'}）`
    : '自动';
  const files = Array.isArray(result.files) ? result.files : [];
  renderReviewSummary(result.source, files.length);
  renderReviewTree(files);
  if (!files.length) {
    reviewDetailTitle.textContent = '工作区无更改';
    reviewDiff.textContent = '暂无可审阅的更改';
  }
}

function renderReviewSummary(source, changedFiles) {
  const sourceLabel = source === 'svn' ? 'SVN' : 'Git';
  reviewSummary.textContent = changedFiles
    ? `${sourceLabel} · ${changedFiles} 个变更`
    : `${sourceLabel} · 工作区无更改`;
}

function renderReviewTreeMessage(message) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = message;
  reviewTree.replaceChildren(empty);
}

function renderReviewTree(files) {
  if (!files.length) {
    renderReviewTreeMessage('工作区无更改');
    return;
  }
  const entries = createReviewTreeEntries(files);
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'review-tree-row';
    row.style.paddingLeft = `${7 + entry.depth * 14}px`;
    row.dataset.path = entry.path;
    row.dataset.directory = String(entry.directory);
    row.title = entry.directory ? entry.path : `${entry.path}（${entry.status}）`;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(entry.depth + 1));
    const arrow = document.createElement('span');
    arrow.className = 'review-tree-arrow';
    arrow.textContent = entry.directory ? '⌄' : '';
    const icon = document.createElement('span');
    icon.className = `review-tree-icon ${entry.directory ? 'is-directory' : 'is-file'}`;
    icon.textContent = entry.directory ? '▱' : '▧';
    const name = document.createElement('span');
    name.className = 'review-tree-name';
    name.textContent = entry.name;
    row.append(arrow, icon, name);
    if (entry.directory) {
      row.setAttribute('aria-expanded', String(!collapsedReviewDirectories.has(entry.path)));
      row.addEventListener('click', () => toggleReviewDirectory(entry.path));
    } else {
      const status = document.createElement('span');
      status.className = `review-tree-status is-${getReviewStatusKind(entry.status)}`;
      status.textContent = entry.status;
      row.append(status);
      row.addEventListener('click', () => void loadReviewFileDiff(entry, row));
    }
    fragment.append(row);
  }
  reviewTree.replaceChildren(fragment);
  updateReviewTreeVisibility();
}

function createReviewTreeEntries(files) {
  const workspaceName = currentWorkspace.split(/[\\/]/).filter(Boolean).at(-1) || '工作区';
  const directories = new Set();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  const entries = [{ path: '.', name: workspaceName, depth: 0, directory: true }];
  for (const directoryPath of directories) {
    const parts = directoryPath.split('/');
    entries.push({ path: directoryPath, name: parts.at(-1), depth: parts.length, directory: true });
  }
  for (const file of files) {
    const parts = file.path.split('/');
    entries.push({ ...file, name: parts.at(-1), depth: parts.length, directory: false });
  }
  return entries.sort((left, right) => {
    if (left.path === '.') return -1;
    if (right.path === '.') return 1;
    return left.path.localeCompare(right.path, 'zh-CN');
  });
}

function toggleReviewDirectory(directoryPath) {
  if (collapsedReviewDirectories.has(directoryPath)) collapsedReviewDirectories.delete(directoryPath);
  else collapsedReviewDirectories.add(directoryPath);
  updateReviewTreeVisibility();
}

function updateReviewTreeVisibility() {
  const collapsed = [...collapsedReviewDirectories];
  for (const row of reviewTree.querySelectorAll('.review-tree-row')) {
    const rowPath = row.dataset.path;
    row.hidden = collapsed.some((directoryPath) => (
      directoryPath === '.' ? rowPath !== '.' : rowPath.startsWith(`${directoryPath}/`)
    ));
    if (row.dataset.directory === 'true') {
      const expanded = !collapsedReviewDirectories.has(rowPath);
      row.setAttribute('aria-expanded', String(expanded));
      row.querySelector('.review-tree-arrow').textContent = expanded ? '⌄' : '›';
    }
  }
}

function getReviewStatusKind(status) {
  if (status.includes('D') || status.includes('!')) return 'deleted';
  if (status.includes('A') || status.includes('?')) return 'added';
  if (status.includes('C') || status.includes('~')) return 'conflict';
  return 'modified';
}

async function loadReviewFileDiff(file, row) {
  const requestId = ++reviewDiffSequence;
  for (const selected of reviewTree.querySelectorAll('.is-selected')) selected.classList.remove('is-selected');
  row.classList.add('is-selected');
  reviewDetailTitle.textContent = file.path;
  reviewDiff.textContent = '正在读取变更详情…';
  reviewDiff.classList.add('empty-state');
  const result = await window.desktop.review.getFileDiff(activeReviewSource, file.path);
  if (requestId !== reviewDiffSequence) return;
  if (!result?.ok) {
    reviewDiff.textContent = result?.error || '无法读取文件变更';
    return;
  }
  reviewDiff.classList.toggle('empty-state', !result.diff);
  if (result.diff) renderReviewDiff(result.diff);
  else reviewDiff.textContent = '该文件没有可显示的文本差异';
}

function renderReviewDiff(diff) {
  const fragment = document.createDocumentFragment();
  let oldLine = null;
  let newLine = null;

  for (const line of diff.split(/\r?\n/)) {
    const row = document.createElement('div');
    row.className = 'diff-line';
    let oldNumber = '';
    let newNumber = '';

    if (line.startsWith('# ')) {
      row.classList.add('diff-section-title');
      oldLine = null;
      newLine = null;
    } else if (line.startsWith('diff --git ') || line.startsWith('Index: ')) {
      row.classList.add('diff-file-header');
      oldLine = null;
      newLine = null;
    } else if (line.startsWith('@@')) {
      row.classList.add('diff-hunk');
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
    } else if (
      line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || line.startsWith('new file mode ')
      || line.startsWith('deleted file mode ')
      || line.startsWith('similarity index ')
      || line.startsWith('rename from ')
      || line.startsWith('rename to ')
      || /^={3,}$/.test(line)
      || line.startsWith('\\ No newline')
    ) {
      row.classList.add('diff-meta');
    } else if (line.startsWith('+')) {
      row.classList.add('diff-line-add');
      newNumber = newLine ?? '';
      if (newLine !== null) newLine += 1;
    } else if (line.startsWith('-')) {
      row.classList.add('diff-line-delete');
      oldNumber = oldLine ?? '';
      if (oldLine !== null) oldLine += 1;
    } else {
      row.classList.add('diff-line-context');
      if (oldLine !== null && newLine !== null) {
        oldNumber = oldLine;
        newNumber = newLine;
        oldLine += 1;
        newLine += 1;
      }
    }

    const oldGutter = document.createElement('span');
    oldGutter.className = 'diff-gutter diff-gutter-old';
    oldGutter.textContent = oldNumber;
    const newGutter = document.createElement('span');
    newGutter.className = 'diff-gutter diff-gutter-new';
    newGutter.textContent = newNumber;
    const code = document.createElement('span');
    code.className = 'diff-code';
    code.textContent = line || ' ';
    row.append(oldGutter, newGutter, code);
    fragment.append(row);
  }

  reviewDiff.replaceChildren(fragment);
}

terminalInput.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void executeTerminalCommand();
    return;
  }
  if (event.key === 'ArrowUp' && terminalHistory.length) {
    event.preventDefault();
    terminalHistoryIndex = Math.max(0, terminalHistoryIndex - 1);
    setTerminalInput(terminalHistory[terminalHistoryIndex] || '');
    return;
  }
  if (event.key === 'ArrowDown' && terminalHistory.length) {
    event.preventDefault();
    terminalHistoryIndex = Math.min(terminalHistory.length, terminalHistoryIndex + 1);
    setTerminalInput(terminalHistory[terminalHistoryIndex] || '');
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    clearTerminal();
  }
});

terminalInput.addEventListener('paste', (event) => {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, text.replace(/[\r\n]+/g, ' '));
});

terminalConsole.addEventListener('click', (event) => {
  if (event.target === clearTerminalButton || window.getSelection()?.toString()) return;
  focusTerminalInput();
});

async function executeTerminalCommand() {
  const command = terminalInput.textContent.trim();
  if (!command || terminalBusy) return;
  terminalBusy = true;
  terminalHistory.push(command);
  terminalHistoryIndex = terminalHistory.length;
  setTerminalInput('');
  terminalInput.contentEditable = 'false';
  appendTerminal(`\nPS ${currentWorkspace}> ${command}\n`);
  try {
    const result = await window.desktop.terminal.run(command);
    if (!result?.ok) appendTerminal(`${result?.error || '命令执行失败'}\n`);
    else if (!result.streamed) {
      if (result.stdout) appendTerminal(result.stdout);
      if (result.stderr) appendTerminal(result.stderr);
    }
    if (result?.ok && result.code !== 0) appendTerminal(`\n[进程退出代码 ${result.code}]\n`);
  } catch (error) {
    appendTerminal(`${error.message || error}\n`);
  } finally {
    terminalBusy = false;
    terminalInput.contentEditable = 'plaintext-only';
    focusTerminalInput();
  }
}

function appendTerminal(text) {
  terminalOutput.textContent += text;
  if (terminalOutput.textContent.length > 200_000) terminalOutput.textContent = terminalOutput.textContent.slice(-160_000);
  terminalConsole.scrollTop = terminalConsole.scrollHeight;
}

function clearTerminal() {
  terminalOutput.textContent = 'DeepSeek Harness 终端';
  terminalConsole.scrollTop = 0;
}

function setTerminalInput(value) {
  terminalInput.textContent = value;
  focusTerminalInput();
}

function focusTerminalInput() {
  terminalInput.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(terminalInput);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

clearTerminalButton.addEventListener('click', clearTerminal);

browserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = browserAddress.value.trim();
  if (!target) return;
  browserAddress.disabled = true;
  const result = await window.desktop.browser.navigate(target);
  browserAddress.disabled = false;
  if (!result?.ok) showSidebarToast(result?.error || '网页加载失败');
  else browserAddress.value = result.url;
});

for (const button of document.querySelectorAll('[data-browser-action]')) {
  button.addEventListener('click', async () => {
    const result = await window.desktop.browser.action(button.dataset.browserAction);
    if (!result?.ok && button.dataset.browserAction !== 'back' && button.dataset.browserAction !== 'forward') {
      showSidebarToast(result?.error || '浏览器操作失败');
    }
  });
}

window.desktop.browser.onState((state) => {
  if (state.url && document.activeElement !== browserAddress) browserAddress.value = state.url;
  browserPlaceholder.hidden = Boolean(state.url);
  const backButton = document.querySelector('[data-browser-action="back"]');
  const forwardButton = document.querySelector('[data-browser-action="forward"]');
  backButton.disabled = !state.canGoBack;
  forwardButton.disabled = !state.canGoForward;
  if (state.error) showSidebarToast(state.error);
});

refreshFilesButton.addEventListener('click', () => void loadFiles());

async function loadFiles() {
  const requestId = ++fileLoadSequence;
  fileTree.innerHTML = '<div class="empty-state">正在读取文件…</div>';
  const result = await window.desktop.workspace.listFiles();
  if (requestId !== fileLoadSequence) return;
  if (!result?.ok) {
    fileTree.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'empty-state';
    error.textContent = result?.error || '无法读取工作区文件';
    fileTree.append(error);
    return;
  }
  currentWorkspace = result.path;
  workspacePath.textContent = currentWorkspace;
  workspacePath.title = currentWorkspace;
  const fragment = document.createDocumentFragment();
  for (const file of result.files) {
    const row = document.createElement('button');
    row.className = 'file-row';
    row.type = 'button';
    row.style.paddingLeft = `${7 + file.depth * 13}px`;
    row.title = file.path;
    row.dataset.path = file.path;
    row.dataset.depth = String(file.depth);
    row.dataset.directory = String(file.directory);
    const glyph = document.createElement('span');
    glyph.className = 'file-glyph';
    glyph.textContent = file.directory ? (collapsedDirectories.has(file.path) ? '›' : '⌄') : '·';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    row.append(glyph, name);
    if (file.directory) {
      row.classList.add('is-directory');
      row.setAttribute('aria-expanded', String(!collapsedDirectories.has(file.path)));
      row.addEventListener('click', () => toggleDirectory(file.path));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft' && !collapsedDirectories.has(file.path)) {
          event.preventDefault();
          collapseDirectory(file.path);
        } else if (event.key === 'ArrowRight' && collapsedDirectories.has(file.path)) {
          event.preventDefault();
          expandDirectory(file.path);
        }
      });
    } else {
      row.addEventListener('click', () => void previewFile(file.path, row));
    }
    fragment.append(row);
  }
  fileTree.replaceChildren(fragment);
  updateFileTreeVisibility();
  if (!result.files.length) fileTree.innerHTML = '<div class="empty-state">工作区为空</div>';
}

function toggleDirectory(directoryPath) {
  if (collapsedDirectories.has(directoryPath)) expandDirectory(directoryPath);
  else collapseDirectory(directoryPath);
}

function collapseDirectory(directoryPath) {
  collapsedDirectories.add(directoryPath);
  updateFileTreeVisibility();
}

function expandDirectory(directoryPath) {
  collapsedDirectories.delete(directoryPath);
  updateFileTreeVisibility();
}

function updateFileTreeVisibility() {
  const collapsed = [...collapsedDirectories];
  for (const row of fileTree.querySelectorAll('.file-row')) {
    const rowPath = row.dataset.path;
    row.hidden = collapsed.some((directoryPath) => rowPath.startsWith(`${directoryPath}/`));
    if (row.dataset.directory === 'true') {
      const expanded = !collapsedDirectories.has(rowPath);
      row.setAttribute('aria-expanded', String(expanded));
      row.querySelector('.file-glyph').textContent = expanded ? '⌄' : '›';
    }
  }
}

async function previewFile(relativePath, row) {
  for (const selected of fileTree.querySelectorAll('.is-selected')) selected.classList.remove('is-selected');
  row.classList.add('is-selected');
  filePreviewName.textContent = relativePath;
  filePreview.textContent = '正在读取文件…';
  filePreview.classList.add('empty-state');
  const result = await window.desktop.workspace.readFile(relativePath);
  filePreview.textContent = result?.ok ? result.content : (result?.error || '无法读取文件');
  filePreview.classList.toggle('empty-state', !result?.ok);
}

refreshPluginsButton.addEventListener('click', () => void loadPlugins());
pluginFilter.addEventListener('submit', (event) => {
  event.preventDefault();
  pluginFilterQuery = pluginFilterInput.value.trim().toLocaleLowerCase();
  renderPluginList(pluginListState);
});
pluginInstallForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const packageSpec = pluginPackageInput.value.trim();
  if (!packageSpec) {
    pluginOperationStatus.dataset.state = 'error';
    pluginOperationStatus.textContent = '请输入 npm 插件包名';
    pluginPackageInput.focus();
    return;
  }
  void performPluginAction('add', packageSpec);
});
pluginRestartButton.addEventListener('click', () => void restartHarnessForPlugins());

async function loadPlugins() {
  pluginOperationStatus.dataset.state = 'loading';
  pluginOperationStatus.textContent = '正在读取 web profile 插件…';
  pluginFilterInput.disabled = true;
  pluginFilterCount.textContent = '';
  pluginList.innerHTML = '<div class="empty-state">正在读取插件…</div>';
  let result;
  try {
    result = await window.desktop.plugins.list();
  } catch (error) {
    result = { ok: false, error: error.message || String(error) };
  }
  if (result?.profileRoot) {
    pluginProfilePath.textContent = result.profileRoot;
    pluginProfilePath.title = result.profileRoot;
  }
  if (!result?.ok) {
    pluginListState = { profileRoot: result?.profileRoot || '', plugins: [] };
    pluginOperationStatus.dataset.state = 'error';
    pluginOperationStatus.textContent = result?.error || '无法读取插件列表';
    pluginFilter.hidden = true;
    pluginList.innerHTML = '<div class="empty-state">插件列表不可用</div>';
    return;
  }
  pluginFilterInput.disabled = false;
  pluginOperationStatus.dataset.state = 'ready';
  pluginOperationStatus.textContent = result.plugins.length
    ? `已安装 ${result.plugins.length} 个插件`
    : '尚未安装额外插件';
  renderPluginList(result);
}

function renderPluginList(state) {
  pluginListState = state;
  const installedPluginNames = new Set(state.plugins.map((plugin) => plugin.name));
  for (const pluginName of expandedPluginNames) {
    if (!installedPluginNames.has(pluginName)) expandedPluginNames.delete(pluginName);
  }
  pluginProfilePath.textContent = state.profileRoot;
  pluginProfilePath.title = state.profileRoot;
  if (!state.plugins.length) {
    pluginFilter.hidden = true;
    pluginFilterInput.value = '';
    pluginFilterQuery = '';
    pluginFilterCount.textContent = '';
    pluginList.innerHTML = '<div class="empty-state">输入 npm 包名即可安装插件</div>';
    return;
  }
  pluginFilter.hidden = false;
  const visiblePlugins = pluginFilterQuery
    ? state.plugins.filter((plugin) => plugin.name.toLocaleLowerCase().includes(pluginFilterQuery))
    : state.plugins;
  pluginFilterCount.textContent = pluginFilterQuery
    ? `${visiblePlugins.length} / ${state.plugins.length}`
    : `${state.plugins.length} 个`;
  if (!visiblePlugins.length) {
    pluginList.innerHTML = '<div class="empty-state">没有匹配的插件</div>';
    return;
  }
  const statusMeta = {
    enabled: { label: '已启用', tone: 'success' },
    installed: { label: '已安装', tone: 'success' },
    update: { label: '有更新', tone: 'warning' },
    error: { label: '异常', tone: 'error' },
    disabled: { label: '已停用', tone: 'neutral' },
  };
  const cards = visiblePlugins.map((plugin) => {
    const card = document.createElement('details');
    card.className = 'plugin-card';
    card.open = expandedPluginNames.has(plugin.name);
    card.addEventListener('toggle', () => {
      if (card.open) expandedPluginNames.add(plugin.name);
      else expandedPluginNames.delete(plugin.name);
    });
    const pluginStatus = Object.hasOwn(statusMeta, plugin.status) ? plugin.status : 'installed';
    const status = statusMeta[pluginStatus];
    card.dataset.status = status.tone;
    const summary = document.createElement('summary');
    summary.className = 'plugin-card-summary';
    const content = document.createElement('div');
    content.className = 'plugin-card-content';
    const name = document.createElement('strong');
    name.textContent = plugin.name;
    name.title = plugin.name;
    content.append(name);
    const statusIndicator = document.createElement('span');
    statusIndicator.className = 'plugin-status-indicator';
    statusIndicator.title = status.label;
    const statusDot = document.createElement('span');
    statusDot.className = 'plugin-status-dot';
    statusDot.setAttribute('aria-hidden', 'true');
    const statusLabel = document.createElement('span');
    statusLabel.textContent = status.label;
    statusIndicator.append(statusDot, statusLabel);
    const chevron = document.createElement('span');
    chevron.className = 'plugin-card-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    summary.append(content, statusIndicator, chevron);
    const details = document.createElement('div');
    details.className = 'plugin-card-details';
    const metadata = document.createElement('div');
    metadata.className = 'plugin-card-metadata';
    const versionLabel = document.createElement('span');
    versionLabel.textContent = '版本';
    const versionValue = document.createElement('code');
    versionValue.textContent = plugin.version;
    const locationLabel = document.createElement('span');
    locationLabel.textContent = '安装位置';
    const locationValue = document.createElement('span');
    locationValue.textContent = 'Web Profile';
    metadata.append(versionLabel, versionValue, locationLabel, locationValue);
    const actions = document.createElement('div');
    actions.className = 'plugin-card-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'plugin-remove-button';
    remove.textContent = '卸载';
    remove.disabled = pluginOperationBusy;
    remove.addEventListener('click', () => {
      if (!window.confirm(`确定从 web profile 卸载 ${plugin.name}？`)) return;
      void performPluginAction('remove', plugin.name);
    });
    actions.append(remove);
    details.append(metadata, actions);
    card.append(summary, details);
    return card;
  });
  pluginList.replaceChildren(...cards);
}

async function performPluginAction(action, value) {
  if (pluginOperationBusy) return;
  setPluginOperationBusy(true);
  const actionLabel = action === 'add' ? '安装' : '卸载';
  pluginOperationStatus.dataset.state = 'loading';
  pluginOperationStatus.textContent = `正在${actionLabel} ${value}，请稍候…`;
  try {
    const result = action === 'add'
      ? await window.desktop.plugins.add(value)
      : await window.desktop.plugins.remove(value);
    if (!result?.ok) {
      pluginOperationStatus.dataset.state = 'error';
      pluginOperationStatus.textContent = result?.error || `插件${actionLabel}失败`;
      return;
    }
    if (action === 'add') pluginPackageInput.value = '';
    pluginOperationStatus.dataset.state = 'success';
    pluginOperationStatus.textContent = `${result.changedPlugin} ${actionLabel}成功`;
    renderPluginList(result);
    pluginRestartBar.hidden = !result.restartRequired;
    showSidebarToast(`插件${actionLabel}成功，重启 Harness 后生效`);
  } catch (error) {
    pluginOperationStatus.dataset.state = 'error';
    pluginOperationStatus.textContent = `插件${actionLabel}失败：${error.message}`;
  } finally {
    setPluginOperationBusy(false);
  }
}

function setPluginOperationBusy(busy) {
  pluginOperationBusy = busy;
  pluginPackageInput.disabled = busy;
  pluginInstallButton.disabled = busy;
  refreshPluginsButton.disabled = busy;
  for (const button of pluginList.querySelectorAll('.plugin-remove-button')) button.disabled = busy;
}

async function restartHarnessForPlugins() {
  pluginRestartButton.disabled = true;
  pluginOperationStatus.dataset.state = 'loading';
  pluginOperationStatus.textContent = '正在重启 Harness…';
  try {
    const result = await window.desktop.dsh.restart();
    if (!result?.ok) {
      pluginOperationStatus.dataset.state = 'error';
      pluginOperationStatus.textContent = result?.error || 'Harness 重启失败';
      return;
    }
    pluginRestartBar.hidden = true;
    pluginOperationStatus.dataset.state = 'success';
    pluginOperationStatus.textContent = 'Harness 已重启，插件变更已应用';
  } catch (error) {
    pluginOperationStatus.dataset.state = 'error';
    pluginOperationStatus.textContent = `Harness 重启失败：${error.message}`;
  } finally {
    pluginRestartButton.disabled = false;
  }
}

function showSidebarToast(message) {
  clearTimeout(sidebarToastTimer);
  sidebarToast.textContent = message;
  sidebarToast.classList.add('is-visible');
  sidebarToastTimer = setTimeout(() => sidebarToast.classList.remove('is-visible'), 2_800);
}

function renderRequirements(requirements) {
  const safeRequirements = Array.isArray(requirements) ? requirements : [];
  const cards = safeRequirements.map((requirement) => {
    const card = document.createElement('label');
    card.className = 'requirement-card';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.requirementId = requirement.id;
    const body = document.createElement('span');
    body.className = 'requirement-body';
    const heading = document.createElement('strong');
    heading.textContent = requirement.name;
    const version = document.createElement('span');
    version.className = 'requirement-version';
    version.textContent = requirement.currentVersion
      ? `当前 ${requirement.currentVersion} · 需要 ${requirement.requiredVersion}`
      : `需要 ${requirement.requiredVersion}`;
    const description = document.createElement('span');
    description.className = 'requirement-description';
    description.textContent = requirement.description;
    body.append(heading, version, description);
    if (requirement.id === 'node' && Array.isArray(requirement.methods)) {
      const select = document.createElement('select');
      select.id = 'node-install-method';
      select.setAttribute('aria-label', 'Node.js 安装方式');
      for (const method of requirement.methods) {
        const option = document.createElement('option');
        option.value = method.id;
        option.textContent = method.label;
        select.append(option);
      }
      select.addEventListener('click', (event) => event.stopPropagation());
      body.append(select);
    }
    checkbox.addEventListener('change', syncRequirementSelection);
    card.append(checkbox, body);
    return card;
  });
  requirementsList.replaceChildren(...cards);
  syncRequirementSelection();
}

function syncRequirementSelection(event) {
  const nodeCheckbox = requirementsList.querySelector('[data-requirement-id="node"]');
  const dshCheckbox = requirementsList.querySelector('[data-requirement-id="dsh"]');
  if (event?.target === dshCheckbox && dshCheckbox.checked && nodeCheckbox) nodeCheckbox.checked = true;
  if (event?.target === nodeCheckbox && !nodeCheckbox.checked && dshCheckbox) dshCheckbox.checked = false;
  const selectedCount = requirementsList.querySelectorAll('input[type="checkbox"]:checked').length;
  installButton.disabled = selectedCount === 0;
  installButton.textContent = selectedCount ? `下载并安装（${selectedCount} 项）` : '请选择安装项目';
}

installButton.addEventListener('click', async () => {
  const requirements = [...requirementsList.querySelectorAll('input[type="checkbox"]:checked')].map((checkbox) => checkbox.dataset.requirementId);
  const nodeInstallMethod = document.querySelector('#node-install-method')?.value || 'managed';
  installButton.disabled = true;
  actionFeedback.textContent = '正在准备下载和安装…';
  try {
    const result = await window.desktop.dsh.installRequirements({ requirements, nodeInstallMethod });
    if (!result.ok && !result.needsInstallation) actionFeedback.textContent = result.error || '安装失败，请查看日志';
  } catch (error) {
    actionFeedback.textContent = `无法开始安装：${error.message}`;
    installButton.disabled = false;
  }
});

retryButton.addEventListener('click', async () => {
  retryButton.disabled = true;
  actionFeedback.textContent = '正在重新检测并启动…';
  try {
    const result = await window.desktop.dsh.retry();
    if (!result.ok) actionFeedback.textContent = result.error || '重试失败，请查看日志';
  } catch (error) {
    actionFeedback.textContent = `无法重试：${error.message}`;
  }
});

openLogsButton.addEventListener('click', () => void openLogs());

async function openLogs() {
  actionFeedback.textContent = '';
  try {
    const result = await window.desktop.dsh.openLogs();
    if (!result.ok) actionFeedback.textContent = result.error || '无法打开日志目录';
  } catch (error) {
    actionFeedback.textContent = `无法打开日志目录：${error.message}`;
  }
}

copyDiagnosticsButton.addEventListener('click', () => void copyDiagnostics());

async function copyDiagnostics() {
  actionFeedback.textContent = '';
  try {
    const result = await window.desktop.dsh.copyDiagnostics();
    actionFeedback.textContent = result.ok ? '诊断信息已复制' : (result.error || '复制失败');
    showSidebarToast(actionFeedback.textContent);
  } catch (error) {
    actionFeedback.textContent = `复制失败：${error.message}`;
    showSidebarToast(actionFeedback.textContent);
  }
}
