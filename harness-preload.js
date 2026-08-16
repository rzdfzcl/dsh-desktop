'use strict';

// Compatibility for third-party bundles built against the legacy dsh client
// stylesheet convention. The current HMR client removes style[data-plugin]
// before refreshing a bundle, while some older bundles inject their CSS only
// when the module factory is evaluated. Their UI stays mounted but its style
// is never added again. Preserve any stylesheet removed through that legacy
// ownership marker; bundles using the current data-plugin-css convention are
// not touched.
const LEGACY_STYLE_SELECTOR = 'style[data-plugin]';
const COMPAT_OWNER_ATTRIBUTE = 'data-dsh-desktop-style-owner';
const pendingRestores = new Map();

function isStyleElement(node) {
  return node?.nodeType === Node.ELEMENT_NODE && node.tagName === 'STYLE';
}

function legacyStylesIn(node) {
  const styles = [];
  if (isStyleElement(node) && node.matches(LEGACY_STYLE_SELECTOR)) styles.push(node);
  if (node?.nodeType === Node.ELEMENT_NODE) {
    styles.push(...node.querySelectorAll(LEGACY_STYLE_SELECTOR));
  }
  return styles;
}

function compatStylesFor(pluginId) {
  return [...document.querySelectorAll(`style[${COMPAT_OWNER_ATTRIBUTE}]`)]
    .filter((style) => style.getAttribute(COMPAT_OWNER_ATTRIBUTE) === pluginId);
}

function hasLiveLegacyStyle(pluginId) {
  return [...document.querySelectorAll(LEGACY_STYLE_SELECTOR)]
    .some((style) => style.getAttribute('data-plugin') === pluginId);
}

function cancelCompatStyle(pluginId) {
  const pending = pendingRestores.get(pluginId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRestores.delete(pluginId);
  }
  for (const style of compatStylesFor(pluginId)) style.remove();
}

function scheduleRestore(pluginId, css) {
  if (!pluginId || !css.trim()) return;
  const previous = pendingRestores.get(pluginId);
  if (previous) clearTimeout(previous.timer);
  const pending = { css, timer: null };
  pending.timer = setTimeout(() => {
    if (pendingRestores.get(pluginId) !== pending) return;
    pendingRestores.delete(pluginId);
    if (hasLiveLegacyStyle(pluginId)) return;

    const existing = compatStylesFor(pluginId);
    const style = existing.shift() || document.createElement('style');
    for (const duplicate of existing) duplicate.remove();
    style.setAttribute(COMPAT_OWNER_ATTRIBUTE, pluginId);
    style.setAttribute('data-plugin-css', `${pluginId}:desktop-compat`);
    style.textContent = pending.css;
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }, 0);
  pendingRestores.set(pluginId, pending);
}

const observer = new MutationObserver((records) => {
  // Process removals first. A style can be inserted and removed in the same
  // microtask during HMR, in which case its final DOM state is disconnected.
  for (const record of records) {
    for (const node of record.removedNodes) {
      for (const style of legacyStylesIn(node)) {
        scheduleRestore(style.getAttribute('data-plugin') || '', style.textContent || '');
      }
    }
  }

  // If the refreshed plugin supplied a live replacement itself, prefer it and
  // discard the temporary compatibility copy.
  for (const record of records) {
    for (const node of record.addedNodes) {
      for (const style of legacyStylesIn(node)) {
        if (style.isConnected) cancelCompatStyle(style.getAttribute('data-plugin') || '');
      }
    }
  }
});

observer.observe(document, { childList: true, subtree: true });
