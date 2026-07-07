// player.js — プレビュー再生エンジン
// タイムライン上のクリップを順番に canvas へ描画し、音声も同期再生する。
// 書き出し(exporter.js)もこの canvas と音声グラフをそのまま録画する。

import { state, on, emit, findClipAt, totalDuration, setTime, setPlaying } from './store.js';
import { compositeFrame } from './renderer.js';
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
  const source = clip.kind === 'video' ? active.video : clip.bitmap;
  if (!source) { clearCanvas(); return; }
  const srcTime = clip.in + Math.max(0, state.currentTime - active.start);
  compositeFrame(ctx, canvas.width, canvas.height, {
    project: state.project,
    clip, source, srcTime,
    timelineTime: state.currentTime,
  });
}

function clearCanvas() {
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
