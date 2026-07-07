// audio.js — 音声解析（デコード・無音検出）
// ジェットカットと自動字幕の両方がここを使う

const ANALYSIS_RATE = 16000; // 解析・文字起こし用のサンプルレート（Whisperの要求仕様）

let decodeCtx = null;
const audioCache = new Map(); // mediaId -> { data: Float32Array(16kHzモノラル), duration }
const CACHE_MAX = 3;

// クリップの音声を16kHzモノラルに変換して返す（結果はキャッシュ）
export async function getAnalysisAudio(mediaId, file) {
  if (audioCache.has(mediaId)) return audioCache.get(mediaId);

  if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await file.arrayBuffer();
  const decoded = await decodeCtx.decodeAudioData(buf);

  // OfflineAudioContextで16kHzモノラルへリサンプル
  const length = Math.ceil(decoded.duration * ANALYSIS_RATE);
  const offline = new OfflineAudioContext(1, length, ANALYSIS_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  const result = { data: rendered.getChannelData(0).slice(), duration: decoded.duration };

  // メモリを食い過ぎないよう古いキャッシュから捨てる
  if (audioCache.size >= CACHE_MAX) {
    audioCache.delete(audioCache.keys().next().value);
  }
  audioCache.set(mediaId, result);
  return result;
}

export function clearAudioCache() { audioCache.clear(); }

// 無音区間の検出。[{start, end}](秒・ソース時間) を返す
// minSilence: この秒数以上続く無音だけをカット対象にする
// sensitivity: 'low' | 'mid' | 'high'（強いほど積極的にカット）
// padding: 無音区間の前後に残す余白（秒）
export function detectSilences(data, {
  minSilence = 0.6,
  sensitivity = 'mid',
  padding = 0.12,
} = {}) {
  const sr = ANALYSIS_RATE;
  const win = Math.round(sr * 0.05); // 50ms窓
  const frames = Math.floor(data.length / win);
  if (frames < 4) return [];

  // フレームごとの音量(dB)
  const db = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const off = i * win;
    for (let j = 0; j < win; j++) sum += data[off + j] * data[off + j];
    const rms = Math.sqrt(sum / win);
    db[i] = 20 * Math.log10(rms + 1e-10);
  }

  // ノイズフロア（静かな方から10%地点）を基準にしきい値を決める
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(frames * 0.1)];
  const offsets = { low: 6, mid: 10, high: 14 };
  let threshold = floor + offsets[sensitivity];
  threshold = Math.min(Math.max(threshold, -60), -22);

  // しきい値未満が minSilence 以上続く区間を拾う
  const silences = [];
  let runStart = -1;
  for (let i = 0; i <= frames; i++) {
    const silent = i < frames && db[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const s = runStart * win / sr;
      const e = i * win / sr;
      if (e - s >= minSilence) {
        // 前後に余白を残す。残りが短すぎる区間は無視
        const ps = s + padding, pe = e - padding;
        if (pe - ps >= 0.15) silences.push({ start: ps, end: pe });
      }
      runStart = -1;
    }
  }
  return silences;
}

// 無音区間の反転＝残す区間（音がある部分）を返す
export function invertToKeep(silences, duration) {
  const keep = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor + 0.05) keep.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (duration > cursor + 0.05) keep.push({ start: cursor, end: duration });
  return keep;
}

// 文字起こし用：無音を境に音声を最大 maxLen 秒の「窓」に分ける
export function buildSpeechWindows(silences, duration, maxLen = 28) {
  const speech = invertToKeep(silences, duration);
  if (!speech.length) return [];
  const windows = [];
  let cur = null;
  for (const seg of speech) {
    if (cur && seg.end - cur.start <= maxLen) {
      cur.end = seg.end; // 直前の窓に繋げられるなら繋げる
      continue;
    }
    if (cur) windows.push(cur);
    cur = { start: seg.start, end: seg.end };
    // 1つの発話が maxLen を超える場合は固定長で刻む
    while (cur.end - cur.start > maxLen) {
      windows.push({ start: cur.start, end: cur.start + maxLen });
      cur = { start: cur.start + maxLen, end: cur.end };
    }
  }
  if (cur) windows.push(cur);
  // 端の取りこぼし防止に少しだけ広げる
  return windows.map(w => ({
    start: Math.max(0, w.start - 0.2),
    end: Math.min(duration, w.end + 0.2),
  }));
}

export function sliceAudio(data, start, end) {
  const sr = ANALYSIS_RATE;
  return data.slice(Math.floor(start * sr), Math.min(data.length, Math.ceil(end * sr)));
}

// 「人の声らしさ」の簡易判定。
// 声は音量の変動が大きく、BGMや機械音・環境音は変動が小さい。
// 音量(dB)の標準偏差がしきい値未満の区間は文字起こし対象から外す
export function looksLikeSpeech(data, start, end) {
  const sr = ANALYSIS_RATE;
  const win = Math.round(sr * 0.05);
  const s = Math.floor(start * sr);
  const e = Math.min(data.length, Math.ceil(end * sr));
  const frames = Math.floor((e - s) / win);
  if (frames < 4) return false;
  const db = [];
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const off = s + i * win;
    for (let j = 0; j < win; j++) sum += data[off + j] * data[off + j];
    db.push(20 * Math.log10(Math.sqrt(sum / win) + 1e-10));
  }
  const mean = db.reduce((a, b) => a + b, 0) / db.length;
  const sd = Math.sqrt(db.reduce((a, b) => a + (b - mean) ** 2, 0) / db.length);
  return sd >= 2.0;
}
