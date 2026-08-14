'use strict';

const statusText = document.querySelector('#status-text');
const splash = document.querySelector('.splash');
const retryButton = document.querySelector('#retry-button');
const openLogsButton = document.querySelector('#open-logs-button');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics-button');
const actionFeedback = document.querySelector('#action-feedback');

window.desktop.dsh.onState(({ state, message }) => {
  statusText.textContent = message;
  splash.dataset.state = state;
  retryButton.disabled = state !== 'error';
  if (state !== 'error') actionFeedback.textContent = '';
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

openLogsButton.addEventListener('click', async () => {
  actionFeedback.textContent = '';
  try {
    const result = await window.desktop.dsh.openLogs();
    if (!result.ok) actionFeedback.textContent = result.error || '无法打开日志目录';
  } catch (error) {
    actionFeedback.textContent = `无法打开日志目录：${error.message}`;
  }
});

copyDiagnosticsButton.addEventListener('click', async () => {
  actionFeedback.textContent = '';
  try {
    const result = await window.desktop.dsh.copyDiagnostics();
    actionFeedback.textContent = result.ok ? '诊断信息已复制' : (result.error || '复制失败');
  } catch (error) {
    actionFeedback.textContent = `复制失败：${error.message}`;
  }
});
