'use strict';

const statusText = document.querySelector('#status-text');
const splash = document.querySelector('.splash');
const retryButton = document.querySelector('#retry-button');
const openLogsButton = document.querySelector('#open-logs-button');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics-button');
const actionFeedback = document.querySelector('#action-feedback');
const requirementsList = document.querySelector('#requirements-list');
const installButton = document.querySelector('#install-button');

window.desktop.dsh.onState(({ state, message, requirements = [] }) => {
  statusText.textContent = message;
  splash.dataset.state = state;
  retryButton.disabled = state !== 'error';
  if (state === 'requirements') {
    renderRequirements(requirements);
    actionFeedback.textContent = '';
  } else {
    requirementsList.replaceChildren();
  }
  if (state !== 'error' && state !== 'requirements') actionFeedback.textContent = '';
});

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
  const requirements = [...requirementsList.querySelectorAll('input[type="checkbox"]:checked')]
    .map((checkbox) => checkbox.dataset.requirementId);
  const nodeInstallMethod = document.querySelector('#node-install-method')?.value || 'managed';
  installButton.disabled = true;
  actionFeedback.textContent = '正在准备下载和安装…';
  try {
    const result = await window.desktop.dsh.installRequirements({ requirements, nodeInstallMethod });
    if (!result.ok && !result.needsInstallation) {
      actionFeedback.textContent = result.error || '安装失败，请查看日志';
    }
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
