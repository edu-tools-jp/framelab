// luts.js — LUT（カラーグレーディング）の読み込み管理とUI
// LUTは選択中のクリップに適用。「すべてに適用」で全クリップへ一括反映もできる

import { state, on, emit } from './store.js';
import { uploadLut, hasLut, isAvailable } from './glfx.js';
import { refreshFrame } from './player.js';

let manifest = null; // { size, luts: [{id, name, group, file}] }
const loading = new Map();

export async function getManifest() {
  if (!manifest) {
    const res = await fetch('lut/manifest.json');
    manifest = await res.json();
  }
  return manifest;
}

// LUTのバイナリを取得してGPUに載せる（多重ロード防止つき）
export async function ensureLutLoaded(lutId) {
  if (hasLut(lutId)) return true;
  if (loading.has(lutId)) return loading.get(lutId);
  const p = (async () => {
    const m = await getManifest();
    const entry = m.luts.find(l => l.id === lutId);
    if (!entry) return false;
    const res = await fetch('lut/' + entry.file);
    const buf = await res.arrayBuffer();
    return uploadLut(lutId, new Uint16Array(buf), m.size);
  })();
  loading.set(lutId, p);
  try { return await p; } finally { loading.delete(lutId); }
}

// プロジェクト読み込み時：使用中のLUTを先読みしておく
export function preloadProjectLuts() {
  if (!state.project) return;
  for (const c of state.project.clips) {
    if (c.lut?.id) ensureLutLoaded(c.lut.id).then(() => refreshFrame());
  }
}

// ---------- UI ----------

const $ = (s) => document.querySelector(s);

export function initLutUI(toast) {
  const modal = $('#lut-modal');

  $('#btn-lut').addEventListener('click', async () => {
    if (!isAvailable()) { toast('この端末はLUTに対応していません'); return; }
    if (!state.selectedClipId) { toast('クリップをタップして選択してから開いてください'); return; }
    await renderLutList();
    syncControls();
    modal.classList.add('open');
  });
  $('#lut-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  $('#lut-intensity').addEventListener('input', (e) => {
    const clip = selectedClip();
    if (clip?.lut) {
      clip.lut.intensity = Number(e.target.value);
      emit('clips');
      refreshFrame();
    }
    $('#lut-intensity-val').textContent = Math.round(Number(e.target.value) * 100) + '%';
  });

  $('#btn-lut-all').addEventListener('click', () => {
    const clip = selectedClip();
    if (!clip) return;
    for (const c of state.project.clips) {
      c.lut = clip.lut ? { ...clip.lut } : null;
    }
    emit('clips');
    refreshFrame();
    toast(clip.lut ? 'すべてのクリップに適用しました' : 'すべてのクリップのLUTを外しました');
  });

  on('select', syncControls);
}

function selectedClip() {
  return state.project?.clips.find(c => c.id === state.selectedClipId) || null;
}

async function renderLutList() {
  const m = await getManifest();
  const wrap = $('#lut-list');
  wrap.innerHTML = '';

  // 「なし」ボタン
  const none = document.createElement('button');
  none.className = 'lut-item';
  none.dataset.lut = '';
  none.textContent = 'なし（元の色）';
  none.addEventListener('click', () => applyLut(null));
  wrap.appendChild(none);

  let currentGroup = '';
  for (const entry of m.luts) {
    if (entry.group !== currentGroup) {
      currentGroup = entry.group;
      const h = document.createElement('div');
      h.className = 'lut-group';
      h.textContent = currentGroup;
      wrap.appendChild(h);
    }
    const b = document.createElement('button');
    b.className = 'lut-item';
    b.dataset.lut = entry.id;
    b.textContent = entry.name;
    b.addEventListener('click', () => applyLut(entry.id));
    wrap.appendChild(b);
  }
  markSelection();
}

async function applyLut(lutId) {
  const clip = selectedClip();
  if (!clip) return;
  if (lutId) {
    const ok = await ensureLutLoaded(lutId);
    if (!ok) return;
    const intensity = clip.lut?.intensity ?? 1.0;
    clip.lut = { id: lutId, intensity };
  } else {
    clip.lut = null;
  }
  emit('clips');
  refreshFrame();
  markSelection();
  syncControls();
}

function markSelection() {
  const clip = selectedClip();
  const cur = clip?.lut?.id || '';
  for (const b of document.querySelectorAll('.lut-item')) {
    b.classList.toggle('on', b.dataset.lut === cur);
  }
}

function syncControls() {
  const clip = selectedClip();
  const st = clip?.lut;
  const slider = $('#lut-intensity');
  if (!slider) return;
  slider.value = st?.intensity ?? 1.0;
  slider.disabled = !st;
  $('#lut-intensity-val').textContent = Math.round((st?.intensity ?? 1.0) * 100) + '%';
  markSelection();
}
