// main.js — 画面遷移とUIの配線

import {
  state, on, createProject, setProject, splitAt, removeClip, moveClip,
  undo, canUndo, fmtTime, totalDuration,
} from './store.js';
import { importFiles } from './importer.js';
import { initPlayer, play, pause, refreshFrame } from './player.js';
import { initTimeline, setZoom } from './timeline.js';
import { exportVideo, saveResult, isExportSupported } from './exporter.js';
import { initPersistence, listProjects, loadProject, deleteProject } from './persist.js';
import { initJetcutUI } from './jetcut.js';
import { initSubtitleUI } from './subtitles.js';
import { initLutUI, preloadProjectLuts } from './luts.js';
import { initTitleUI } from './titles.js';
import { initMusicUI } from './music.js';

const $ = (sel) => document.querySelector(sel);

// ---- 画面切り替え ----
function show(screenId) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('active', s.id === screenId);
  }
}

// ---- ホーム画面（新規プロジェクト） ----
const RESOLUTIONS = { '1080': [1920, 1080], '4k': [3840, 2160] };

function setupHome() {
  let orientation = 'landscape';
  let resKey = '1080';
  let fps = 30;

  const sync = () => {
    for (const b of document.querySelectorAll('[data-orient]')) {
      b.classList.toggle('on', b.dataset.orient === orientation);
    }
    for (const b of document.querySelectorAll('[data-res]')) {
      b.classList.toggle('on', b.dataset.res === resKey);
    }
    for (const b of document.querySelectorAll('[data-fps]')) {
      b.classList.toggle('on', Number(b.dataset.fps) === fps);
    }
  };

  document.querySelectorAll('[data-orient]').forEach(b =>
    b.addEventListener('click', () => { orientation = b.dataset.orient; sync(); }));
  document.querySelectorAll('[data-res]').forEach(b =>
    b.addEventListener('click', () => { resKey = b.dataset.res; sync(); }));
  document.querySelectorAll('[data-fps]').forEach(b =>
    b.addEventListener('click', () => { fps = Number(b.dataset.fps); sync(); }));
  sync();

  $('#btn-create').addEventListener('click', () => {
    const [w, h] = RESOLUTIONS[resKey];
    const landscape = orientation === 'landscape';
    const d = new Date();
    createProject({
      name: $('#project-name').value.trim() ||
        `プロジェクト ${d.getMonth() + 1}-${d.getDate()}`,
      orientation,
      width: landscape ? w : h,
      height: landscape ? h : w,
      fps,
    });
    $('#editor-title').textContent = state.project.name;
    show('screen-editor');
    updateEmptyState();
  });
}

// 保存済みプロジェクトの一覧表示
async function renderProjectList() {
  const panel = $('#project-list-panel');
  const list = $('#project-list');
  try {
    const projects = await listProjects();
    if (!projects.length) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    list.innerHTML = '';
    for (const p of projects) {
      const row = document.createElement('div');
      row.className = 'proj-row';

      const thumb = document.createElement('div');
      thumb.className = 'proj-thumb';
      if (p.thumb) thumb.style.backgroundImage = `url(${p.thumb})`;

      const info = document.createElement('div');
      info.className = 'proj-info';
      const d = new Date(p.updatedAt);
      info.innerHTML = `<b>${escapeHtml(p.name)}</b>
        <small>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ・ ${fmtTime(p.duration || 0).slice(0, 5)}</small>`;

      const del = document.createElement('button');
      del.className = 'proj-del';
      del.textContent = '削除';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`「${p.name}」を削除しますか？（元に戻せません）`)) return;
        await deleteProject(p.id);
        renderProjectList();
      });

      row.append(thumb, info, del);
      row.addEventListener('click', () => openSaved(p.id));
      list.appendChild(row);
    }
  } catch (err) {
    console.error('一覧の読み込み失敗:', err);
    panel.style.display = 'none';
  }
}

async function openSaved(id) {
  try {
    toast('読み込み中…');
    const { project, missing } = await loadProject(id);
    setProject(project);
    preloadProjectLuts();
    $('#editor-title').textContent = project.name;
    show('screen-editor');
    updateEmptyState();
    refreshFrame();
    if (missing.length) toast(`一部の素材が見つかりませんでした: ${missing.join(', ')}`);
  } catch (err) {
    console.error(err);
    toast('読み込みに失敗しました');
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- エディタ画面 ----
function setupEditor() {
  initPlayer($('#preview-canvas'));
  initTimeline($('#timeline'));

  // 素材追加
  const fileInput = $('#file-input');
  $('#btn-add').addEventListener('click', () => fileInput.click());
  $('#btn-add-empty').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files.length) return;
    const files = [...fileInput.files];
    fileInput.value = '';
    toast(`${files.length}件を読み込み中…`);
    await importFiles(files);
    updateEmptyState();
    refreshFrame();
    toast('読み込み完了');
  });

  // 再生・停止
  $('#btn-play').addEventListener('click', () => {
    if (state.playing) pause(); else play();
  });
  on('playing', () => {
    $('#btn-play').textContent = state.playing ? '⏸' : '▶';
  });

  // 時刻表示（再生位置の変化とクリップ編集の両方で更新）
  const updateTimeDisplay = () => {
    $('#time-display').textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
  };
  on('time', updateTimeDisplay);
  on('clips', updateTimeDisplay);

  // 編集操作
  $('#btn-split').addEventListener('click', () => {
    if (!splitAt(state.currentTime)) toast('ここでは分割できません');
  });
  $('#btn-delete').addEventListener('click', () => {
    if (!state.selectedClipId) { toast('クリップをタップして選択してください'); return; }
    removeClip(state.selectedClipId);
    updateEmptyState();
    refreshFrame();
  });
  $('#btn-move-left').addEventListener('click', () => {
    if (state.selectedClipId) { moveClip(state.selectedClipId, -1); refreshFrame(); }
  });
  $('#btn-move-right').addEventListener('click', () => {
    if (state.selectedClipId) { moveClip(state.selectedClipId, 1); refreshFrame(); }
  });
  $('#btn-zoom-in').addEventListener('click', () => setZoom(1.4));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(1 / 1.4));

  // 取り消し
  $('#btn-undo').addEventListener('click', () => {
    const label = undo();
    if (label) { toast(`「${label}」を取り消しました`); refreshFrame(); updateEmptyState(); }
  });
  on('undo', () => { $('#btn-undo').disabled = !canUndo(); });

  on('select', () => {
    const has = !!state.selectedClipId;
    $('#btn-delete').disabled = !has;
    $('#btn-move-left').disabled = !has;
    $('#btn-move-right').disabled = !has;
  });

  // 戻る（編集内容は自動保存されている）
  $('#btn-back').addEventListener('click', () => {
    pause();
    show('screen-home');
    renderProjectList();
  });

  // 書き出し
  $('#btn-export').addEventListener('click', startExport);
}

function updateEmptyState() {
  const empty = !state.project || !state.project.clips.length;
  $('#empty-state').style.display = empty ? 'flex' : 'none';
  $('#btn-export').disabled = empty;
}

// ---- 書き出しモーダル ----
async function startExport() {
  if (!isExportSupported()) { toast('この端末は書き出しに対応していません'); return; }
  const modal = $('#export-modal');
  const bar = $('#export-bar');
  const msg = $('#export-msg');
  const actions = $('#export-actions');
  modal.classList.add('open');
  actions.innerHTML = '';
  msg.textContent = '書き出し中… 画面を閉じずにお待ちください（再生と同じ時間がかかります）';
  bar.style.width = '0%';

  const onProgress = (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; };
  on('export-progress', onProgress);

  try {
    const result = await exportVideo();
    bar.style.width = '100%';
    msg.textContent = `完成！ ${result.filename}（${(result.blob.size / 1024 / 1024).toFixed(1)} MB）`;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn primary';
    saveBtn.textContent = '保存 / 共有';
    saveBtn.addEventListener('click', async () => {
      const how = await saveResult(result);
      if (how === 'downloaded') toast('ダウンロードしました');
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => modal.classList.remove('open'));
    actions.append(saveBtn, closeBtn);
  } catch (err) {
    console.error(err);
    msg.textContent = '書き出しに失敗しました: ' + err.message;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => modal.classList.remove('open'));
    actions.append(closeBtn);
  }
}

// ---- トースト通知 ----
let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---- 開発用: ?dev=1 でテスト素材を自動読み込み ----
async function devAutoload() {
  createProject({ name: 'devテスト', orientation: 'landscape', width: 1280, height: 720, fps: 30 });
  $('#editor-title').textContent = state.project.name;
  show('screen-editor');
  const names = ['clipJP.mp4', 'clipA.mp4', 'clipB.mp4'];
  const files = [];
  for (const n of names) {
    const res = await fetch('testassets/' + n);
    if (!res.ok) continue;
    const blob = await res.blob();
    files.push(new File([blob], n, { type: 'video/mp4' }));
  }
  await importFiles(files);
  updateEmptyState();
  refreshFrame();
}

// ---- 起動 ----
// 予期しないエラーを見えるようにする（実機での不具合調査用）
window.addEventListener('error', (e) => console.error('未捕捉エラー:', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('未処理のPromise拒否:', e.reason));

window.addEventListener('DOMContentLoaded', () => {
  setupHome();
  setupEditor();
  initPersistence();
  initJetcutUI(toast);
  initSubtitleUI();
  initLutUI(toast);
  initTitleUI(toast);
  initMusicUI(toast);
  show('screen-home');
  renderProjectList();

  // PWA: 本番（https）のみサービスワーカーを登録
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }

  if (new URLSearchParams(location.search).get('dev') === '1') {
    devAutoload().catch(err => console.error('devAutoload失敗:', err));
  }
});
