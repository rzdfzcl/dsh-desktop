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
const reviewStatus = document.querySelector('#review-status');
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
const environmentDialog = document.querySelector('#environment-dialog');
const environmentDialogPanel = document.querySelector('#environment-dialog-panel');
const environmentDialogIcon = document.querySelector('#environment-dialog-icon');
const environmentDialogSummary = document.querySelector('#environment-dialog-summary');
const environmentDialogList = document.querySelector('#environment-dialog-list');
const environmentDialogClose = document.querySelector('#environment-dialog-close');
const environmentDialogDone = document.querySelector('#environment-dialog-done');
const topNavigation = document.querySelector('#top-navigation');
const harnessServiceStatus = document.querySelector('#harness-service-status');
const harnessStatusLabel = document.querySelector('#harness-status-label');
const topMenuButtons = [...document.querySelectorAll('[data-top-menu]')];
const topMenuPopovers = [...document.querySelectorAll('[data-top-menu-popover]')];
const topActionButtons = [...document.querySelectorAll('[data-top-action]')];

const toolTitles = { review: '审阅', terminal: '终端', browser: '浏览器', files: '文件' };
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
let activeTopMenu = null;
let lastContentFocus = null;
let environmentDialogPreviousFocus = null;

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
    const result = await window.desktop.dsh.checkEnvironment();
    if (!Array.isArray(result?.items)) {
      showSidebarToast(result?.error || '无法检查运行环境');
      return result;
    }
    await showEnvironmentDialog(result);
    return result;
  }
  if (action === 'copy-diagnostics') return copyDiagnostics();
  if (action === 'reload') return runNavigationAction('reload');
  if (action === 'restart-harness') {
    const result = await window.desktop.dsh.restart();
    if (!result?.ok) showSidebarToast(result?.error || 'Harness 服务重启失败');
    return result;
  }
  if (action === 'toggle-sidebar') return window.desktop.sidebar.setOpen(!sidebarOpen);
  if (action.startsWith('tool-')) {
    await window.desktop.sidebar.setTool(action.slice(5));
    return window.desktop.sidebar.setOpen(true);
  }
  if (['copy', 'paste', 'select-all'].includes(action)) {
    if (lastContentFocus?.isConnected && typeof lastContentFocus.focus === 'function') lastContentFocus.focus();
    const result = await window.desktop.navigation.edit(action);
    if (!result?.ok) showSidebarToast(result?.error || '编辑操作失败');
  }
}

async function showEnvironmentDialog(report) {
  environmentDialogPreviousFocus = document.activeElement;
  environmentDialog.dataset.status = report.ok ? 'ready' : 'warning';
  environmentDialogIcon.textContent = report.ok ? '✓' : '!';
  const failedCount = report.items.filter((item) => !item.ok).length;
  environmentDialogSummary.textContent = report.ok
    ? 'Node.js、npm、dsh 与 pnpm 均已就绪'
    : `发现 ${failedCount} 项需要处理`;
  const rows = report.items.map((item) => {
    const row = document.createElement('article');
    row.className = 'environment-item';
    row.dataset.ok = String(Boolean(item.ok));
    const state = document.createElement('span');
    state.className = 'environment-item-state';
    state.textContent = item.ok ? '✓' : '!';
    const content = document.createElement('div');
    content.className = 'environment-item-content';
    const heading = document.createElement('div');
    heading.className = 'environment-item-heading';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const badge = document.createElement('span');
    badge.textContent = item.ok ? '正常' : '需处理';
    const detail = document.createElement('div');
    detail.className = 'environment-item-detail';
    detail.textContent = item.detail;
    heading.append(name, badge);
    content.append(heading, detail);
    row.append(state, content);
    return row;
  });
  environmentDialogList.replaceChildren(...rows);
  await window.desktop.ui.setModalOpen(true);
  environmentDialog.hidden = false;
  document.body.classList.add('has-modal-open');
  environmentDialogPanel.focus();
}

function closeEnvironmentDialog() {
  if (environmentDialog.hidden) return;
  environmentDialog.hidden = true;
  document.body.classList.remove('has-modal-open');
  void window.desktop.ui.setModalOpen(false);
  if (environmentDialogPreviousFocus?.isConnected) environmentDialogPreviousFocus.focus();
  environmentDialogPreviousFocus = null;
}

environmentDialogClose.addEventListener('click', closeEnvironmentDialog);
environmentDialogDone.addEventListener('click', closeEnvironmentDialog);
environmentDialog.addEventListener('pointerdown', (event) => {
  if (event.target === environmentDialog) closeEnvironmentDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || environmentDialog.hidden) return;
  event.preventDefault();
  closeEnvironmentDialog();
});

void initializeSidebar();

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
  button.addEventListener('click', () => void window.desktop.sidebar.setTool(button.dataset.sidebarTool));
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
  workspacePath.textContent = currentWorkspace || '未选择工作区';
  workspacePath.title = currentWorkspace;
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
  loadedTools.add(activeTool);
}

chooseWorkspaceButton.addEventListener('click', () => void chooseWorkspace());

async function chooseWorkspace() {
  const result = await window.desktop.workspace.choose();
  if (!result?.ok) return;
  currentWorkspace = result.path;
  collapsedDirectories.clear();
  loadedTools.delete('review');
  loadedTools.delete('files');
  applySidebarState(true, activeTool, result.path, sidebarPanelWidth);
  await loadActiveTool(true);
  showSidebarToast(`已切换工作区：${result.name}`);
}

refreshReviewButton.addEventListener('click', () => void loadReview());

async function loadReview() {
  reviewSummary.textContent = '正在刷新…';
  reviewStatus.textContent = '正在读取 Git 状态…';
  reviewDiff.textContent = '';
  reviewDiff.classList.add('empty-state');
  const result = await window.desktop.review.get();
  if (!result?.ok) {
    reviewSummary.textContent = '无法审阅';
    reviewStatus.textContent = result?.error || '读取 Git 状态失败';
    reviewDiff.textContent = '请选择一个 Git 工作区';
    return;
  }
  const changedFiles = result.status.split(/\r?\n/).filter((line) => line && !line.startsWith('##')).length;
  const diffLines = result.diff.split(/\r?\n/);
  const additions = diffLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = diffLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  renderReviewSummary(changedFiles, additions, deletions);
  reviewStatus.textContent = result.status || '工作区无更改';
  reviewDiff.classList.toggle('empty-state', !result.diff);
  if (result.diff) renderReviewDiff(result.diff);
  else reviewDiff.textContent = '暂无可审阅的更改';
}

function renderReviewSummary(changedFiles, additions, deletions) {
  if (!changedFiles) {
    reviewSummary.textContent = '工作区无更改';
    return;
  }
  const files = document.createElement('span');
  files.textContent = `${changedFiles} 个文件`;
  const added = document.createElement('span');
  added.className = 'diff-count-add';
  added.textContent = `+${additions}`;
  const deleted = document.createElement('span');
  deleted.className = 'diff-count-delete';
  deleted.textContent = `-${deletions}`;
  reviewSummary.replaceChildren(files, added, deleted);
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
    } else if (line.startsWith('diff --git ')) {
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
  fileTree.innerHTML = '<div class="empty-state">正在读取文件…</div>';
  const result = await window.desktop.workspace.listFiles();
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
