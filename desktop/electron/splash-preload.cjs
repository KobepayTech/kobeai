'use strict';

const { ipcRenderer } = require('electron');

let latest = { pct: 0, msg: 'Starting…' };

function render() {
  const bar = document.getElementById('bar');
  const status = document.getElementById('status');
  if (!bar || !status) return;
  const pct = Math.min(100, Math.max(0, Number(latest.pct) || 0));
  bar.style.width = `${pct}%`;
  bar.parentElement.setAttribute('aria-valuenow', String(pct));
  if (latest.msg) status.textContent = String(latest.msg);
}

ipcRenderer.on('boot-progress', (_event, progress = {}) => {
  latest = { pct: progress.pct, msg: progress.msg };
  render();
});

window.addEventListener('DOMContentLoaded', () => {
  const version = new URLSearchParams(window.location.search).get('version');
  const label = document.getElementById('version');
  if (label && version) label.textContent = `v${version}`;
  render();
}, { once: true });
