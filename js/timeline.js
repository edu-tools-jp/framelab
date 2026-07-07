// timeline.js — タイムラインUI（クリップ表示・選択・スクラブ・ズーム）

import { state, on, clipDuration, totalDuration, setSelected, fmtTime } from './store.js';
import { seek } from './player.js';

let scrollEl, contentEl, rulerEl, trackEl, playheadEl;
let scrubbing = false;

const TRACK_H = 64;

export function initTimeline(root) {
  root.innerHTML = `
    <div class="tl-scroll" id="tl-scroll">
      <div class="tl-content" id="tl-content">
        <div class="tl-ruler" id="tl-ruler"></div>
        <div class="tl-track" id="tl-track"></div>
        <div class="tl-playhead" id="tl-playhead"></div>
      </div>
    </div>`;
  scrollEl = root.querySelector('#tl-scroll');
  contentEl = root.querySelector('#tl-content');
  rulerEl = root.querySelector('#tl-ruler');
  trackEl = root.querySelector('#tl-track');
  playheadEl = root.querySelector('#tl-playhead');

  on('clips', render);
  on('project', render);
  on('select', updateSelection);
  on('time', updatePlayhead);

  // ルーラー／空きスペースのドラッグで再生位置を動かす（スクラブ）
  scrollEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tl-clip')) return; // クリップのタップは選択に使う
    scrubbing = true;
    scrollEl.setPointerCapture(e.pointerId);
    scrubTo(e);
  });
  scrollEl.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
  scrollEl.addEventListener('pointerup', () => { scrubbing = false; });
  scrollEl.addEventListener('pointercancel', () => { scrubbing = false; });
}

function scrubTo(e) {
  const rect = scrollEl.getBoundingClientRect();
  const x = e.clientX - rect.left + scrollEl.scrollLeft;
  seek(x / state.pxPerSec);
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
