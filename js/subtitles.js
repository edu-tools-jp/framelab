// subtitles.js — 自動字幕（日本語）
// 音声を無音で区切った「窓」ごとにWhisperワーカーへ渡し、
// 単語タイムスタンプから読みやすい字幕行を組み立てる。
// 字幕は素材のソース時間に紐づくので、後からカット編集しても追従する。

import {
  state, on, emit, newId, setTranscript, getTranscript, hasAnyTranscript,
  updateSegmentText, deleteSegment, setSubtitleStyle, clipStartTime, fmtTime,
} from './store.js';
import { getAnalysisAudio, detectSilences, buildSpeechWindows, sliceAudio, looksLikeSpeech } from './audio.js';
import { seek, refreshFrame } from './player.js';

export const MODELS = {
  accurate: { id: 'Xenova/whisper-small', label: '高精度（おすすめ）', dl: '約250MB' },
  fast: { id: 'Xenova/whisper-base', label: '高速', dl: '約80MB' },
};

// よくあるフィラー（つなぎ言葉）のパターン
const FILLER_RE = /^(えー+と?ー*|えっと+ー*|え+っ?とー*|あー+|んー+|うー+ん+|あのー+|そのー+|ま[ぁあ]ー+)$/;

// ---------- ワーカー管理 ----------

let worker = null;
let reqSeq = 0;
const pending = new Map();
let progressHandler = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('js/whisper-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'model-progress') {
      progressHandler?.({ phase: 'model', pct: msg.progress });
    } else if (msg.type === 'ready') {
      pending.get('load')?.resolve();
      pending.delete('load');
    } else if (msg.type === 'result') {
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    } else if (msg.type === 'error') {
      const key = msg.id ?? 'load';
      pending.get(key)?.reject(new Error(msg.message));
      pending.delete(key);
    }
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'ワーカーエラー'));
    pending.clear();
  };
  return worker;
}

function workerLoad(model) {
  ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set('load', { resolve, reject });
    worker.postMessage({ cmd: 'load', model });
  });
}

function workerTranscribe(model, audio) {
  ensureWorker();
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ cmd: 'transcribe', model, audio, id }, [audio.buffer]);
  });
}

// ---------- 字幕生成 ----------

export async function generateSubtitles(modelKey, onProgress) {
  progressHandler = onProgress;
  const model = MODELS[modelKey].id;

  // 対象：タイムライン上の動画素材（重複なし・登場順）
  const medias = [];
  const seen = new Set();
  for (const c of state.project.clips) {
    if (c.kind === 'video' && !seen.has(c.mediaId)) {
      seen.add(c.mediaId);
      medias.push(c);
    }
  }
  if (!medias.length) throw new Error('動画クリップがありません');

  onProgress({ phase: 'model', pct: 0 });
  await workerLoad(model);

  for (let m = 0; m < medias.length; m++) {
    const clip = medias[m];
    onProgress({ phase: 'decode', mediaIndex: m, mediaCount: medias.length });
    const { data, duration } = await getAnalysisAudio(clip.mediaId, clip.file);

    // 無音を境に窓割り（無音はそもそも文字起こし不要なのでスキップされ高速化にもなる）
    const silences = detectSilences(data, { minSilence: 0.35, sensitivity: 'mid', padding: 0.1 });
    let windows = buildSpeechWindows(silences, duration);
    if (!windows.length && duration > 0.5) {
      windows = [{ start: 0, end: Math.min(duration, 28) }];
    }
    // 声らしくない窓（BGMのみ・機械音など）はAIの幻覚防止のためスキップ
    windows = windows.filter(w => looksLikeSpeech(data, w.start, w.end));

    const words = [];
    let mode = 'word';
    for (let i = 0; i < windows.length; i++) {
      onProgress({
        phase: 'transcribe', done: i, total: windows.length,
        mediaIndex: m, mediaCount: medias.length,
      });
      const w = windows[i];
      const res = await workerTranscribe(model, sliceAudio(data, w.start, w.end));
      if (res.mode === 'segment') mode = 'segment';
      for (const c of res.chunks) {
        // AIが素材の長さを超えるタイムスタンプを返すことがあるので丸める
        words.push({
          text: c.text,
          start: Math.min(c.start + w.start, duration),
          end: Math.min(c.end + w.start, duration),
        });
      }
    }

    let segments;
    let wordsOut = null;
    if (mode === 'word') {
      markFillers(words);
      segments = buildCaptionsFromWords(words);
      wordsOut = words;
    } else {
      segments = words
        .map(c => ({ id: newId(), start: c.start, end: c.end, text: c.text.trim() }))
        .filter(s => s.text && s.end > s.start);
    }
    setTranscript(clip.mediaId, { segments, words: wordsOut, mode });
  }
  progressHandler = null;
}

// 単語列から読みやすい字幕行を組み立てる
function buildCaptionsFromWords(words) {
  const MAX_CHARS = 20;
  const MAX_DUR = 5.0;
  const GAP = 0.7;
  const caps = [];
  let cur = null;

  for (const w of words) {
    const txt = w.text;
    if (!txt.trim()) continue;
    if (!cur) {
      cur = { start: w.start, end: w.end, text: txt };
    } else if (
      w.start - cur.end > GAP ||
      cur.text.replace(/\s/g, '').length >= MAX_CHARS ||
      w.end - cur.start > MAX_DUR
    ) {
      caps.push(cur);
      cur = { start: w.start, end: w.end, text: txt };
    } else {
      cur.text += txt;
      cur.end = w.end;
    }
    if (cur && /[。？！?!]\s*$/.test(cur.text)) {
      caps.push(cur);
      cur = null;
    }
  }
  if (cur) caps.push(cur);

  // 表示時間の整形：短すぎる字幕は少し延ばす（次の字幕にぶつからない範囲で）
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const minEnd = c.start + 1.0;
    const limit = i + 1 < caps.length ? caps[i + 1].start : Infinity;
    c.end = Math.min(Math.max(c.end, minEnd), Math.max(c.end, limit));
    c.text = c.text.trim();
  }
  return caps
    .filter(c => c.text && c.end > c.start)
    .map(c => ({ id: newId(), start: c.start, end: c.end, text: c.text }));
}

// フィラー（えー、あのー等）の単語に印をつける。1〜3語の連結でも判定する
function markFillers(words) {
  for (let i = 0; i < words.length; i++) {
    for (let len = 3; len >= 1; len--) {
      if (i + len > words.length) break;
      const group = words.slice(i, i + len);
      if (group.some(w => w.filler)) continue;
      // 語間に隙間があるものは連結しない
      let joined = '';
      let ok = true;
      for (let k = 0; k < group.length; k++) {
        if (k > 0 && group[k].start - group[k - 1].end > 0.25) { ok = false; break; }
        joined += group[k].text.trim();
      }
      if (ok && FILLER_RE.test(joined)) {
        for (const w of group) w.filler = true;
        break;
      }
    }
  }
}

// フィラー区間（ソース時間）を返す。ジェットカットが利用する
export function fillerIntervals(mediaId) {
  const tr = getTranscript(mediaId);
  if (!tr?.words) return [];
  const out = [];
  for (const w of tr.words) {
    if (!w.filler) continue;
    const last = out[out.length - 1];
    if (last && w.start - last.end < 0.2) last.end = Math.max(last.end, w.end + 0.04);
    else out.push({ start: Math.max(0, w.start - 0.04), end: w.end + 0.04 });
  }
  return out;
}

// ---------- 字幕パネルUI ----------

const $ = (s) => document.querySelector(s);

const PRESETS = {
  standard: { label: '標準', color: '#ffffff', outline: '#000000', bg: false, font: 'sans' },
  yellow: { label: 'イエロー', color: '#ffe14d', outline: '#000000', bg: false, font: 'sans' },
  band: { label: '黒帯', color: '#ffffff', outline: 'rgba(0,0,0,0)', bg: true, font: 'sans' },
  cinema: { label: 'シネマ', color: '#f2ecd8', outline: '#1a1a1a', bg: false, font: 'serif' },
};

export function initSubtitleUI() {
  const sheet = $('#subtitle-sheet');

  $('#btn-subtitles').addEventListener('click', () => {
    openTab(hasAnyTranscript() ? 'list' : 'gen');
    sheet.classList.add('open');
  });
  $('#subtitle-close').addEventListener('click', () => sheet.classList.remove('open'));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.classList.remove('open'); });

  for (const b of document.querySelectorAll('[data-subtab]')) {
    b.addEventListener('click', () => openTab(b.dataset.subtab));
  }

  // ---- 生成タブ ----
  let modelKey = 'accurate';
  for (const b of document.querySelectorAll('[data-model]')) {
    b.addEventListener('click', () => {
      modelKey = b.dataset.model;
      syncModelButtons(modelKey);
    });
  }
  syncModelButtons(modelKey);

  $('#btn-generate-subs').addEventListener('click', async () => {
    const btn = $('#btn-generate-subs');
    const bar = $('#subgen-bar');
    const msg = $('#subgen-msg');
    btn.disabled = true;
    try {
      await generateSubtitles(modelKey, (p) => {
        if (p.phase === 'model') {
          bar.style.width = (p.pct || 0) + '%';
          msg.textContent = `AIモデルを準備中… ${(p.pct || 0).toFixed(0)}%（初回のみダウンロード）`;
        } else if (p.phase === 'decode') {
          bar.style.width = '0%';
          msg.textContent = `音声を解析中…（${p.mediaIndex + 1}/${p.mediaCount}本目）`;
        } else if (p.phase === 'transcribe') {
          const pct = p.total ? (p.done / p.total * 100) : 0;
          bar.style.width = pct + '%';
          msg.textContent = `文字起こし中… ${p.done}/${p.total}（${p.mediaIndex + 1}/${p.mediaCount}本目）`;
        }
      });
      bar.style.width = '100%';
      msg.textContent = '完了！';
      renderCaptionList();
      openTab('list');
    } catch (err) {
      console.error(err);
      msg.textContent = '失敗しました: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- スタイルタブ ----
  const styleTab = $('#subtab-style');
  styleTab.querySelector('#sub-visible').addEventListener('change', (e) => {
    setSubtitleStyle({ visible: e.target.checked });
  });
  for (const key of Object.keys(PRESETS)) {
    const b = styleTab.querySelector(`[data-preset="${key}"]`);
    b?.addEventListener('click', () => {
      const { label, ...styles } = PRESETS[key];
      setSubtitleStyle(styles);
      syncStyleTab();
    });
  }
  styleTab.querySelector('#sub-size').addEventListener('input', (e) => {
    setSubtitleStyle({ size: Number(e.target.value) });
  });
  for (const b of styleTab.querySelectorAll('[data-subpos]')) {
    b.addEventListener('click', () => {
      setSubtitleStyle({ position: b.dataset.subpos });
      syncStyleTab();
    });
  }

  on('transcripts', renderCaptionList);
  on('clips', renderCaptionList);
  on('project', () => { renderCaptionList(); syncStyleTab(); });
}

function syncModelButtons(key) {
  for (const b of document.querySelectorAll('[data-model]')) {
    b.classList.toggle('on', b.dataset.model === key);
  }
}

function openTab(name) {
  for (const b of document.querySelectorAll('[data-subtab]')) {
    b.classList.toggle('on', b.dataset.subtab === name);
  }
  for (const t of document.querySelectorAll('.subtab')) {
    t.classList.toggle('active', t.id === 'subtab-' + name);
  }
  if (name === 'list') renderCaptionList();
  if (name === 'style') syncStyleTab();
}

function syncStyleTab() {
  const st = state.project?.subtitleStyle;
  if (!st) return;
  $('#sub-visible').checked = st.visible;
  $('#sub-size').value = st.size;
  for (const b of document.querySelectorAll('[data-subpos]')) {
    b.classList.toggle('on', b.dataset.subpos === st.position);
  }
}

// 字幕がタイムライン上のどこに現れるかを求める（現れないなら null）
function timelinePosOf(mediaId, seg) {
  for (const clip of state.project.clips) {
    if (clip.mediaId !== mediaId) continue;
    if (seg.start >= clip.in - 0.01 && seg.start < clip.out) {
      return clipStartTime(clip) + Math.max(0, seg.start - clip.in);
    }
  }
  return null;
}

function renderCaptionList() {
  const list = $('#caption-list');
  if (!list || !state.project) return;
  list.innerHTML = '';

  const entries = [];
  const seen = new Set();
  for (const clip of state.project.clips) {
    if (seen.has(clip.mediaId)) continue;
    seen.add(clip.mediaId);
    const tr = state.project.transcripts[clip.mediaId];
    if (!tr?.segments) continue;
    for (const seg of tr.segments) {
      entries.push({ mediaId: clip.mediaId, seg, at: timelinePosOf(clip.mediaId, seg) });
    }
  }

  if (!entries.length) {
    list.innerHTML = '<p class="hint">字幕がまだありません。「生成」タブから作成してください。</p>';
    return;
  }
  entries.sort((a, b) => (a.at ?? 1e9) - (b.at ?? 1e9));

  for (const { mediaId, seg, at } of entries) {
    const row = document.createElement('div');
    row.className = 'cap-row' + (at === null ? ' off' : '');

    const time = document.createElement('button');
    time.className = 'cap-time';
    time.textContent = at !== null ? fmtTime(at).slice(0, 5) : 'カット済';
    if (at !== null) {
      time.addEventListener('click', () => { seek(at + 0.01); });
    }

    const input = document.createElement('input');
    input.className = 'cap-text';
    input.value = seg.text;
    input.addEventListener('change', () => {
      updateSegmentText(mediaId, seg.id, input.value);
    });

    const del = document.createElement('button');
    del.className = 'cap-del';
    del.textContent = '×';
    del.addEventListener('click', () => { deleteSegment(mediaId, seg.id); });

    row.append(time, input, del);
    list.appendChild(row);
  }
}
