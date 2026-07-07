// titles.js — タイトルテンプレート（表示アニメーション付き）とUI
// タイトルはタイムライン時間に固定で置かれる。カット編集は先に済ませるのがおすすめ

import { state, on, emit, newId, fmtTime } from './store.js';
import { seek, refreshFrame } from './player.js';

// ---------- 描画ヘルパー ----------

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// progress(0..1)を「入り→表示→抜け」の3フェーズに分解
function phases(p, inRatio = 0.15, outRatio = 0.15) {
  const fadeIn = clamp01(p / inRatio);
  const fadeOut = clamp01((1 - p) / outRatio);
  return { in: easeOut(fadeIn), out: easeOut(fadeOut), alpha: Math.min(fadeIn, fadeOut) };
}

function setFont(ctx, px, weight = 800, serif = false) {
  ctx.font = `${weight} ${px}px ${serif
    ? '"Hiragino Mincho ProN", "Yu Mincho", serif'
    : '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif'}`;
}

function drawLines(ctx, lines, x, y, lineH, fill, strokePx = 0, stroke = '#000') {
  for (let i = 0; i < lines.length; i++) {
    if (strokePx > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = strokePx;
      ctx.strokeStyle = stroke;
      ctx.strokeText(lines[i], x, y + i * lineH);
    }
    ctx.fillStyle = fill;
    ctx.fillText(lines[i], x, y + i * lineH);
  }
}

// ---------- テンプレート定義 ----------
// draw(ctx, W, H, {lines, p}) — pは0..1の進行度

export const TEMPLATES = {
  simple: {
    name: 'シンプル',
    hint: '中央にすっとフェード',
    draw(ctx, W, H, { lines, p }) {
      const ph = phases(p);
      const px = H * 0.085;
      setFont(ctx, px);
      ctx.textAlign = 'center';
      ctx.globalAlpha = ph.alpha;
      drawLines(ctx, lines, W / 2, H / 2 - (lines.length - 1) * px * 0.65, px * 1.3,
        '#ffffff', px * 0.1, 'rgba(0,0,0,0.85)');
      ctx.globalAlpha = 1;
    },
  },
  lower: {
    name: 'ロワーサード',
    hint: '左下の帯＋スライドイン',
    draw(ctx, W, H, { lines, p }) {
      const ph = phases(p, 0.18, 0.14);
      const px = H * 0.055;
      setFont(ctx, px, 700);
      ctx.textAlign = 'left';
      const slide = (1 - ph.in) * -W * 0.25 + (1 - ph.out) * W * 0.05;
      const x = W * 0.06 + slide;
      const baseY = H * 0.82;
      const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
      ctx.globalAlpha = ph.alpha;
      ctx.fillStyle = 'rgba(16,18,22,0.82)';
      ctx.fillRect(x - px * 0.6, baseY - px * 1.35,
        widest + px * 1.2, lines.length * px * 1.35 + px * 0.5);
      ctx.fillStyle = '#ffc233';
      ctx.fillRect(x - px * 0.6, baseY - px * 1.35, px * 0.12, lines.length * px * 1.35 + px * 0.5);
      drawLines(ctx, lines, x, baseY, px * 1.35, '#ffffff');
      ctx.globalAlpha = 1;
    },
  },
  typewriter: {
    name: 'タイプライター',
    hint: '一文字ずつ打ち出す',
    draw(ctx, W, H, { lines, p }) {
      const ph = phases(p, 0.5, 0.12); // 前半かけて打ち終わる
      const px = H * 0.06;
      setFont(ctx, px, 600);
      ctx.textAlign = 'left';
      const all = lines.join('\n');
      const shown = Math.floor(all.length * clamp01(p / 0.5));
      const partial = all.slice(0, shown).split('\n');
      const x = W * 0.08;
      const y = H * 0.2;
      ctx.globalAlpha = ph.out;
      drawLines(ctx, partial, x, y, px * 1.4, '#ffffff', px * 0.12, 'rgba(0,0,0,0.9)');
      // カーソル点滅
      if (p < 0.5 && Math.floor(p * 40) % 2 === 0 && partial.length) {
        const last = partial[partial.length - 1];
        const cx = x + ctx.measureText(last).width + px * 0.15;
        ctx.fillStyle = '#ffc233';
        ctx.fillRect(cx, y + (partial.length - 1) * px * 1.4 - px * 0.85, px * 0.12, px);
      }
      ctx.globalAlpha = 1;
    },
  },
  pop: {
    name: 'ポップ',
    hint: '弾んで登場',
    draw(ctx, W, H, { lines, p }) {
      const ph = phases(p, 0.2, 0.12);
      const px = H * 0.09;
      // バウンス（少しオーバーシュートして戻る）
      const t = clamp01(p / 0.2);
      const scale = t < 1 ? 0.6 + 0.55 * easeOut(t) - 0.15 * Math.sin(t * Math.PI) : 1;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(scale, scale);
      setFont(ctx, px, 900);
      ctx.textAlign = 'center';
      ctx.globalAlpha = ph.alpha;
      drawLines(ctx, lines, 0, -(lines.length - 1) * px * 0.65, px * 1.3,
        '#ffc233', px * 0.16, 'rgba(0,0,0,0.9)');
      ctx.restore();
      ctx.globalAlpha = 1;
    },
  },
  cinema: {
    name: 'シネマ',
    hint: '黒帯＋明朝でゆっくり',
    draw(ctx, W, H, { lines, p }) {
      const ph = phases(p, 0.25, 0.25);
      const bar = H * 0.12 * ph.in;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
      const px = H * 0.065;
      setFont(ctx, px, 600, true);
      ctx.textAlign = 'center';
      ctx.globalAlpha = ph.alpha;
      drawLines(ctx, lines, W / 2, H / 2 - (lines.length - 1) * px * 0.75, px * 1.5, '#f2ecd8');
      ctx.globalAlpha = 1;
    },
  },
  slide: {
    name: 'スライド',
    hint: '右からスッと入って左へ抜ける',
    draw(ctx, W, H, { lines, p }) {
      const ph = phases(p, 0.15, 0.15);
      const px = H * 0.075;
      setFont(ctx, px, 800);
      ctx.textAlign = 'center';
      const x = W / 2 + (1 - ph.in) * W * 0.4 - (1 - ph.out) * W * 0.4;
      ctx.globalAlpha = ph.alpha;
      drawLines(ctx, lines, x, H * 0.3, px * 1.3, '#ffffff', px * 0.1, 'rgba(0,0,0,0.85)');
      ctx.globalAlpha = 1;
    },
  },
  endroll: {
    name: 'エンドロール',
    hint: '下から上へ流れるクレジット',
    draw(ctx, W, H, { lines, p }) {
      const px = H * 0.05;
      setFont(ctx, px, 500);
      ctx.textAlign = 'center';
      const lineH = px * 1.7;
      const totalH = lines.length * lineH;
      // 画面下端から全行が上へ抜けるまでスクロール
      const y = H + px - p * (H + totalH + px * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, H);
      drawLines(ctx, lines, W / 2, y, lineH, '#ffffff');
    },
  },
};

// タイムライン時間 t に表示中のタイトルを描画する（player.jsから呼ばれる）
export function drawTitles(ctx, W, H, t) {
  const titles = state.project?.titles;
  if (!titles?.length) return;
  for (const title of titles) {
    if (t < title.start || t >= title.start + title.duration) continue;
    const tpl = TEMPLATES[title.templateId];
    if (!tpl) continue;
    const lines = title.text.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    const p = (t - title.start) / title.duration;
    ctx.save();
    tpl.draw(ctx, W, H, { lines, p });
    ctx.restore();
  }
}

// ---------- UI ----------

const $ = (s) => document.querySelector(s);
let editingId = null;

export function initTitleUI(toast) {
  const modal = $('#title-modal');

  $('#btn-title').addEventListener('click', () => {
    showList();
    modal.classList.add('open');
  });
  $('#title-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  $('#btn-title-add').addEventListener('click', () => openEditor(null));

  // テンプレート選択肢
  const grid = $('#title-templates');
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    const b = document.createElement('button');
    b.className = 'choice sm tpl';
    b.dataset.tpl = id;
    b.innerHTML = `${tpl.name}<small>${tpl.hint}</small>`;
    b.addEventListener('click', () => {
      for (const x of grid.querySelectorAll('.tpl')) x.classList.toggle('on', x === b);
      syncDurationRange();
    });
    grid.appendChild(b);
  }

  $('#title-duration').addEventListener('input', () => {
    $('#title-duration-val').textContent = Number($('#title-duration').value).toFixed(1) + '秒';
  });

  $('#btn-title-save').addEventListener('click', () => {
    const text = $('#title-text').value;
    if (!text.trim()) { toast('テキストを入力してください'); return; }
    const templateId = $('#title-templates .tpl.on')?.dataset.tpl || 'simple';
    const duration = Number($('#title-duration').value);
    if (editingId) {
      const t = state.project.titles.find(x => x.id === editingId);
      if (t) Object.assign(t, { text, templateId, duration });
    } else {
      state.project.titles.push({
        id: newId(), templateId, text,
        start: state.currentTime,
        duration,
      });
    }
    emit('titles');
    refreshFrame();
    showList();
  });

  $('#btn-title-delete').addEventListener('click', () => {
    if (editingId) {
      state.project.titles = state.project.titles.filter(t => t.id !== editingId);
      emit('titles');
      refreshFrame();
    }
    showList();
  });

  on('project', renderTitleList);
  on('titles', renderTitleList);
}

function showList() {
  $('#title-editor').style.display = 'none';
  $('#title-list-view').style.display = 'block';
  renderTitleList();
}

function openEditor(title) {
  editingId = title?.id || null;
  $('#title-list-view').style.display = 'none';
  $('#title-editor').style.display = 'block';
  $('#title-text').value = title?.text || '';
  const tplId = title?.templateId || 'simple';
  for (const x of document.querySelectorAll('#title-templates .tpl')) {
    x.classList.toggle('on', x.dataset.tpl === tplId);
  }
  syncDurationRange();
  $('#title-duration').value = title?.duration || 4;
  $('#title-duration-val').textContent = Number($('#title-duration').value).toFixed(1) + '秒';
  $('#btn-title-delete').style.display = editingId ? 'inline-block' : 'none';
  $('#title-editor-pos').textContent = editingId
    ? `表示位置: ${fmtTime(title.start)}`
    : `表示位置: 現在の再生位置（${fmtTime(state.currentTime)}）`;
}

// エンドロールは長め、通常タイトルは短めのレンジに
function syncDurationRange() {
  const isEnd = document.querySelector('#title-templates .tpl.on')?.dataset.tpl === 'endroll';
  const slider = $('#title-duration');
  slider.min = isEnd ? 5 : 1;
  slider.max = isEnd ? 60 : 15;
  if (Number(slider.value) > Number(slider.max)) slider.value = slider.max;
  if (Number(slider.value) < Number(slider.min)) slider.value = isEnd ? 15 : 4;
  $('#title-duration-val').textContent = Number(slider.value).toFixed(1) + '秒';
}

function renderTitleList() {
  const list = $('#title-list');
  if (!list || !state.project) return;
  list.innerHTML = '';
  const titles = [...(state.project.titles || [])].sort((a, b) => a.start - b.start);
  if (!titles.length) {
    list.innerHTML = '<p class="hint">タイトルがまだありません。再生ヘッドを出したい場面に合わせて「＋追加」してください。</p>';
    return;
  }
  for (const t of titles) {
    const row = document.createElement('div');
    row.className = 'cap-row';
    const time = document.createElement('button');
    time.className = 'cap-time';
    time.textContent = fmtTime(t.start).slice(0, 5);
    time.addEventListener('click', () => seek(t.start + 0.05));
    const label = document.createElement('button');
    label.className = 'title-row-label';
    label.textContent = `[${TEMPLATES[t.templateId]?.name || '?'}] ${t.text.split('\n')[0]}`;
    label.addEventListener('click', () => openEditor(t));
    row.append(time, label);
    list.appendChild(row);
  }
}
