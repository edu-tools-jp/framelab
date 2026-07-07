// timeline.js — タイムラインUI（クリップ表示・選択・スクラブ・ズーム）

import { state, on, clipDuration, totalDuration, setSelected, fmtTime } from './store.js';
import { seek, play, pause } from './player.js';

let scrollEl, contentEl, rulerEl, trackEl, playheadEl;
let scrubbing = false;
let resumeAfterScrub = false;
let lastScrubAt = 0;
let scrubStartX = 0;
let scrubMoved = false;

const TRACK_H = 64;

export function initTimeline(root) {
  root.innerHTML = `
    <div class="tl-scroll" id="tl-scroll">
      <div class="tl-content" id="tl-content">
        <div class="tl-ruler" id="tl-ruler"></div>
        <div class="tl-track" id="tl-track"></div>
        <div class="tl-playhead" id="tl-playhead">
          <div class="tl-ph-handle" id="tl-ph-handle"></div>
        </div>
      </div>
    </div>`;
  scrollEl = root.querySelector('#tl-scroll');
  contentEl = root.querySelector('#tl-content');
  rulerEl = root.querySelector('#tl-ruler');
  trackEl = root.querySelector('#tl-track');
  playheadEl = root.querySelector('#tl-playhead');
  const handleEl = root.querySelector('#tl-ph-handle');

  on('clips', render);
  on('project', render);
  on('select', updateSelection);
  on('time', updatePlayhead);

  // 再生ヘッドのつまみを指でドラッグ（touch-action:noneでスクロールと競合しない）
  handleEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { handleEl.setPointerCapture(e.pointerId); } catch { }
    beginScrub(e);
  });
  handleEl.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
  handleEl.addEventListener('pointerup', (e) => {
    const wasMoved = scrubMoved;
    endScrub();
    // 動かさず軽くタップしただけなら、下にあるクリップの選択として扱う
    if (!wasMoved) tapThroughToClip(e, handleEl);
  });
  handleEl.addEventListener('pointercancel', endScrub);

  // ルーラー／空きスペースのドラッグでも動かせる
  scrollEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tl-clip') || e.target.closest('.tl-ph-handle')) return;
    try { scrollEl.setPointerCapture(e.pointerId); } catch { }
    beginScrub(e);
  });
  scrollEl.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
  scrollEl.addEventListener('pointerup', endScrub);
  scrollEl.addEventListener('pointercancel', endScrub);
}

function beginScrub(e) {
  scrubbing = true;
  scrubStartX = e.clientX;
  scrubMoved = false;
  resumeAfterScrub = state.playing;
  if (state.playing) pause(); // ドラッグ中は一時停止（終わったら再開）
  lastScrubAt = 0;
  scrubTo(e);
}

function endScrub() {
  if (!scrubbing) return;
  scrubbing = false;
  if (resumeAfterScrub) play();
  resumeAfterScrub = false;
}

function scrubTo(e) {
  if (Math.abs(e.clientX - scrubStartX) > 8) scrubMoved = true;
  // シークの連発を抑える（40ms間隔）
  const now = performance.now();
  if (now - lastScrubAt < 40) return;
  lastScrubAt = now;
  const rect = scrollEl.getBoundingClientRect();
  const x = e.clientX - rect.left + scrollEl.scrollLeft;
  seek(Math.max(0, x / state.pxPerSec));
}

// つまみ越しのタップを下のクリップに届ける
function tapThroughToClip(e, handleEl) {
  handleEl.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  handleEl.style.pointerEvents = '';
  el?.closest('.tl-clip')?.click();
}

export function setZoom(factor) {
  state.pxPerSec = Math.max(10, Math.min(300, state.pxPerSec * factor));
  render();
}

function render() {
  if (!state.project) return;
  const pps = state.pxPerSec;
  const total = totalDuration();
  const width = Math.max(total * pps + 200, scrollEl.clientWidth);
  contentEl.style.width = width + 'px';

  renderRuler(total, pps, width);

  trackEl.innerHTML = '';
  let t = 0;
  for (const clip of state.project.clips) {
    const dur = clipDuration(clip);
    const el = document.createElement('div');
    el.className = 'tl-clip' + (clip.id === state.selectedClipId ? ' selected' : '');
    el.dataset.id = clip.id;
    el.style.left = (t * pps) + 'px';
    el.style.width = Math.max(dur * pps - 2, 8) + 'px';

    const thumbsWrap = document.createElement('div');
    thumbsWrap.className = 'tl-thumbs';
    const thumbW = TRACK_H * 16 / 9;
    const need = Math.max(1, Math.ceil((dur * pps) / thumbW));
    for (let i = 0; i < need; i++) {
      const img = document.createElement('img');
      const idx = clip.thumbs.length
        ? Math.min(clip.thumbs.length - 1, Math.floor(i / need * clip.thumbs.length))
        : -1;
      if (idx >= 0) img.src = clip.thumbs[idx];
      img.draggable = false;
      thumbsWrap.appendChild(img);
    }
    el.appendChild(thumbsWrap);

    const label = document.createElement('div');
    label.className = 'tl-label';
    label.textContent = `${clip.kind === 'photo' ? '写真 ' : ''}${fmtTime(dur)}`;
    el.appendChild(label);

    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', () => {
      setSelected(clip.id === state.selectedClipId ? null : clip.id);
    });

    trackEl.appendChild(el);
    t += dur;
  }
  updatePlayhead();
}

function renderRuler(total, pps, width) {
  // 目盛り間隔：ズームに応じて 1/2/5/10/30/60秒 から選ぶ
  const steps = [0.5, 1, 2, 5, 10, 30, 60];
  const step = steps.find(s => s * pps >= 50) || 60;
  let html = '';
  for (let t = 0; t <= width / pps; t += step) {
    html += `<span class="tl-tick" style="left:${t * pps}px">${fmtTime(t).slice(0, 5)}</span>`;
  }
  rulerEl.innerHTML = html;
}

function updateSelection() {
  for (const el of trackEl.querySelectorAll('.tl-clip')) {
    el.classList.toggle('selected', el.dataset.id === state.selectedClipId);
  }
}

function updatePlayhead() {
  if (!playheadEl) return;
  const x = state.currentTime * state.pxPerSec;
  playheadEl.style.left = x + 'px';
  // 再生中は再生ヘッドが見える位置に自動スクロール
  if (state.playing && !scrubbing) {
    const view = scrollEl.scrollLeft;
    const vw = scrollEl.clientWidth;
    if (x < view + 40 || x > view + vw - 40) {
      scrollEl.scrollLeft = Math.max(0, x - vw / 3);
    }
  }
}
