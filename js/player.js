// player.js — プレビュー再生エンジン
// タイムライン上のクリップを順番に canvas へ描画し、音声も同期再生する。
// 書き出し(exporter.js)もこの canvas と音声グラフをそのまま録画する。

import { state, on, emit, findClipAt, totalDuration, setTime, setPlaying, captionAtSource } from './store.js';
import { processFrame } from './glfx.js';
import { drawTitles } from './titles.js';
import { getAnalysisAudio, detectSilences, invertToKeep } from './audio.js';

let canvas, ctx;
let audioCtx = null;
let masterGain = null;
let masterMuted = false;

const videoPool = new Map();   // url -> HTMLVideoElement（分割クリップは同じ動画要素を共有）
const audioNodes = new Map();  // url -> MediaElementAudioSourceNode
const trackNodes = new Map();  // 音声トラックid -> { el, gain }
const speechMap = new Map();   // mediaId -> 発話区間 [{start,end}] | 'pending'（ダッキング用）

let active = null;             // { clip, start, video? }
let rafId = null;
let intervalId = null;
let inTick = false;
let lastTick = 0;
let onEndedCallback = null;

// 再生ループは rAF ＋ setInterval の二重駆動。
// タブが非表示になると rAF は完全停止するため、タイマーが引き継いで
// 再生・書き出しが止まらないようにする（描画頻度は落ちるが進行は続く）
function startLoop() {
  stopLoop();
  lastTick = performance.now();
  rafId = requestAnimationFrame(tick);
  intervalId = setInterval(() => {
    if (!state.playing) return;
    const now = performance.now();
    if (now - lastTick >= 40) tick(now);
  }, 33);
}

function stopLoop() {
  cancelAnimationFrame(rafId);
  clearInterval(intervalId);
  intervalId = null;
}

export function initPlayer(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  on('project', () => {
    if (!state.project) return;
    canvas.width = state.project.width;
    canvas.height = state.project.height;
    clearCanvas();
  });
  on('clips', () => {
    if (!state.playing) refreshFrame();
  });
  // 字幕テキストやスタイルが変わったら停止中でも描き直す
  on('transcripts', () => { if (!state.playing) drawActive(); });
  on('style', () => { if (!state.playing) drawActive(); });
  on('titles', () => { if (!state.playing) drawActive(); });
  on('audio', () => syncAudioTracks(true));
}

export function getCanvas() { return canvas; }

// トラブル調査用：再生エンジンの内部状態を覗く
let tickCount = 0;
export function _debug() {
  return {
    tickCount,
    playing: state.playing,
    currentTime: state.currentTime,
    active: active ? {
      clipId: active.clip.id,
      kind: active.clip.kind,
      in: active.clip.in,
      out: active.clip.out,
      start: active.start,
      videoTime: active.video?.currentTime,
      videoPaused: active.video?.paused,
      videoReadyState: active.video?.readyState,
      videoError: active.video?.error?.message || null,
    } : null,
    speaking: isSpeakingNow(),
    tracks: [...trackNodes.entries()].map(([id, n]) => ({
      id,
      paused: n.el.paused,
      time: n.el.currentTime,
      gain: n.gain.gain.value,
    })),
  };
}

// 音声グラフ（初回のユーザー操作時に生成 — iOSの自動再生制限対策）
export function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return { audioCtx, masterGain };
}

// アテレコ録音中は本編音声を消音する（マイクへの回り込み防止）
export function setMasterMuted(muted) {
  masterMuted = muted;
  if (masterGain) masterGain.gain.value = muted ? 0 : 1;
}

function videoFor(clip) {
  let v = videoPool.get(clip.url);
  if (!v) {
    v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = clip.url;
    videoPool.set(clip.url, v);
  }
  return v;
}

function connectAudio(v, url) {
  if (!audioCtx || audioNodes.has(url)) return;
  try {
    const node = audioCtx.createMediaElementSource(v);
    node.connect(masterGain);
    audioNodes.set(url, node);
  } catch { /* 既に接続済みなら無視 */ }
}

async function seekVideo(v, t) {
  if (Math.abs(v.currentTime - t) < 0.01) return;
  v.currentTime = t;
  await new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    setTimeout(done, 3000);
  });
}

// タイムライン位置 t のクリップをアクティブにする
async function activate(t) {
  const hit = findClipAt(t);
  if (!hit) { active = null; return null; }
  const { clip, offset, start } = hit;

  if (active && active.clip.id !== clip.id && active.video) {
    active.video.pause();
  }

  if (clip.kind === 'video') {
    const v = videoFor(clip);
    connectAudio(v, clip.url);
    await seekVideo(v, clip.in + offset);
    active = { clip, start, video: v };
    if (state.playing) {
      try { await v.play(); } catch (e) { console.warn('再生開始に失敗:', e); }
    }
  } else {
    active = { clip, start, video: null };
  }
  return active;
}

export async function play(onEnded) {
  if (!state.project || !state.project.clips.length) return;
  ensureAudio();
  onEndedCallback = onEnded || null;
  if (state.currentTime >= totalDuration() - 0.05) setTime(0);
  setPlaying(true);
  await activate(state.currentTime);
  syncAudioTracks(true);
  startLoop();
}

export function pause() {
  setPlaying(false);
  stopLoop();
  if (active && active.video) active.video.pause();
  for (const [, node] of trackNodes) {
    if (!node.el.paused) node.el.pause();
  }
}

export async function seek(t) {
  const wasPlaying = state.playing;
  if (wasPlaying) pause();
  setTime(t);
  await activate(state.currentTime);
  syncAudioTracks(true);
  drawActive();
  if (wasPlaying) play(onEndedCallback);
}

// 停止中にタイムラインが編集されたとき、現在位置のフレームを描き直す
export async function refreshFrame() {
  if (!state.project) return;
  await activate(state.currentTime);
  drawActive();
}

async function tick(now) {
  if (!state.playing || inTick) return;
  inTick = true;
  tickCount++;
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  try {
    if (!active) {
      stopAtEnd();
      return;
    }

    const { clip, start } = active;
    const clipEnd = start + (clip.out - clip.in);
    let t;

    if (clip.kind === 'video') {
      t = start + (active.video.currentTime - clip.in);
      if (active.video.ended || t >= clipEnd - 0.01) t = clipEnd;
    } else {
      t = Math.min(state.currentTime + dt, clipEnd);
    }

    if (t >= clipEnd - 0.001) {
      // 次のクリップへ
      if (clipEnd >= totalDuration() - 0.01) {
        setTime(totalDuration());
        drawActive();
        stopAtEnd();
        return;
      }
      setTime(clipEnd + 0.001);
      await activate(state.currentTime);
      if (!state.playing) return; // 切り替え中に停止された
    } else {
      setTime(t);
    }

    syncAudioTracks();
    drawActive();
  } finally {
    inTick = false;
  }
  if (state.playing) rafId = requestAnimationFrame(tick);
}

// ---- 音声トラック（BGM・アテレコ）----

function ensureTrack(item) {
  let node = trackNodes.get(item.id);
  if (node) return node;
  if (!item.url) return null;
  ensureAudio();
  const el = new Audio();
  el.preload = 'auto';
  el.src = item.url;
  const gain = audioCtx.createGain();
  gain.gain.value = item.volume;
  try {
    const src = audioCtx.createMediaElementSource(el);
    src.connect(gain);
  } catch (e) {
    console.warn('音声トラックの接続に失敗:', e);
  }
  gain.connect(masterGain);
  node = { el, gain };
  trackNodes.set(item.id, node);
  return node;
}

// 各トラックを再生位置に同期し、ダッキング音量を反映する
function syncAudioTracks(force = false) {
  if (!state.project) return;
  const tracks = state.project.audio || [];

  // 削除されたトラックの後始末
  for (const [id, node] of trackNodes) {
    if (!tracks.some(t => t.id === id)) {
      node.el.pause();
      node.el.removeAttribute('src');
      trackNodes.delete(id);
    }
  }

  const speaking = isSpeakingNow();
  for (const item of tracks) {
    const node = ensureTrack(item);
    if (!node) continue;
    const local = state.currentTime - item.start;
    const inRange = local >= 0 && local < item.duration - 0.05;

    if (state.playing && inRange) {
      if (node.el.paused || force) {
        if (Math.abs(node.el.currentTime - local) > 0.2) {
          try { node.el.currentTime = Math.max(0, local); } catch { }
        }
        node.el.play().catch(() => { });
      } else if (Math.abs(node.el.currentTime - local) > 0.4) {
        node.el.currentTime = local; // ズレが大きければ補正
      }
      if (item.duck) prepareSpeechIntervals();
    } else {
      if (!node.el.paused) node.el.pause();
      if (force && inRange) {
        try { node.el.currentTime = Math.max(0, local); } catch { }
      }
    }

    const target = item.volume * (item.duck && speaking ? 0.22 : 1);
    if (audioCtx) {
      node.gain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.09);
    }
  }
}

// ダッキング用：動画素材の「声がある区間」をバックグラウンドで解析しておく
function prepareSpeechIntervals() {
  if (!state.project) return;
  for (const clip of state.project.clips) {
    if (clip.kind !== 'video' || speechMap.has(clip.mediaId)) continue;
    speechMap.set(clip.mediaId, 'pending');
    (async () => {
      try {
        const { data, duration } = await getAnalysisAudio(clip.mediaId, clip.file);
        const sil = detectSilences(data, { minSilence: 0.3, sensitivity: 'mid', padding: 0.08 });
        speechMap.set(clip.mediaId, invertToKeep(sil, duration));
      } catch {
        speechMap.set(clip.mediaId, []);
      }
    })();
  }
}

function isSpeakingNow() {
  if (!active || active.clip.kind !== 'video') return false;
  const intervals = speechMap.get(active.clip.mediaId);
  if (!Array.isArray(intervals)) return false;
  const srcT = active.clip.in + Math.max(0, state.currentTime - active.start);
  return intervals.some(iv => srcT >= iv.start && srcT < iv.end);
}

function stopAtEnd() {
  pause();
  const cb = onEndedCallback;
  onEndedCallback = null;
  emit('ended');
  if (cb) cb();
}

function drawActive() {
  if (!active) { clearCanvas(); return; }
  const { clip } = active;
  let source = clip.kind === 'video' ? active.video : clip.bitmap;
  if (!source) { clearCanvas(); return; }

  // LUT（カラーグレーディング）
  if (clip.lut?.id) {
    const graded = processFrame(source, clip.lut.id, clip.lut.intensity ?? 1);
    if (graded) source = graded;
  }

  drawContain(source);
  drawTitles(ctx, canvas.width, canvas.height, state.currentTime);
  drawCaption(clip);
}

// ---- 字幕描画（プレビューにも書き出しにもそのまま反映される）----

function drawCaption(clip) {
  const style = state.project?.subtitleStyle;
  if (!style?.visible) return;
  // クリップ内のソース時間から表示すべき字幕を探す
  const srcT = clip.in + Math.max(0, state.currentTime - active.start);
  const seg = captionAtSource(clip.mediaId, srcT);
  if (!seg) return;

  const W = canvas.width, H = canvas.height;
  const px = Math.round(H * style.size);
  const family = style.font === 'serif'
    ? '"Hiragino Mincho ProN", "Yu Mincho", serif'
    : '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.font = `700 ${px}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const lines = wrapText(seg.text, W * 0.9);
  const lineH = px * 1.35;
  const padY = H * 0.05;
  let baseY = style.position === 'top'
    ? padY + lineH
    : H - padY - (lines.length - 1) * lineH;

  for (let i = 0; i < lines.length; i++) {
    const y = baseY + i * lineH;
    const line = lines[i];
    if (style.bg) {
      const w = ctx.measureText(line).width;
      const bx = W / 2 - w / 2 - px * 0.4;
      const by = y - px * 1.05;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      roundRect(bx, by, w + px * 0.8, px * 1.4, px * 0.2);
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.16;
    ctx.strokeStyle = style.outline;
    ctx.strokeText(line, W / 2, y);
    ctx.fillStyle = style.color;
    ctx.fillText(line, W / 2, y);
  }
}

function wrapText(text, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3); // 最大3行まで
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// アスペクト比を保って中央に描画（縦プロジェクト×横素材などは黒帯）
function drawContain(source) {
  const W = canvas.width, H = canvas.height;
  const sw = source.videoWidth || source.width;
  const sh = source.videoHeight || source.height;
  if (!sw || !sh) return;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function clearCanvas() {
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
