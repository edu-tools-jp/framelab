// audio-mix.js — 書き出し用に、プロジェクト全体の音声を1本のバッファへレンダリングする
// クリップの音声＋BGM＋アテレコを合成し、ダッキング（声の間だけBGMを下げる）も反映する

import { getAnalysisAudio, detectSilences, invertToKeep } from './audio.js';

const decodeCache = new Map(); // mediaId -> AudioBuffer

// project の全音声を OfflineAudioContext でミックスし、AudioBuffer を返す（音が無ければ null）
export async function renderProjectAudio(project, sampleRate = 48000) {
  const clips = project.clips;
  const tracks = project.audio || [];
  const totalDur = clips.reduce((s, c) => s + (c.out - c.in), 0);
  if (totalDur <= 0) return null;

  const hasAnyAudio = clips.some(c => c.kind === 'video') || tracks.length > 0;
  if (!hasAnyAudio) return null;

  const length = Math.ceil(totalDur * sampleRate); // 映像の尺ぴったり（余白なし）
  const octx = new OfflineAudioContext(2, length, sampleRate);

  async function decode(mediaId, file) {
    if (decodeCache.has(mediaId)) return decodeCache.get(mediaId);
    const buf = await file.arrayBuffer();
    const decoded = await octx.decodeAudioData(buf);
    decodeCache.set(mediaId, decoded);
    return decoded;
  }

  // 1. 動画クリップの音声を時系列に並べる。同時に「声がある区間」も集める（ダッキング用）
  let tl = 0;
  const speech = [];
  for (const clip of clips) {
    const dur = clip.out - clip.in;
    if (clip.kind === 'video') {
      try {
        const decoded = await decode(clip.mediaId, clip.file);
        const src = octx.createBufferSource();
        src.buffer = decoded;
        src.connect(octx.destination);
        src.start(tl, clip.in, dur); // [in, out] をタイムライン tl に配置
      } catch (e) {
        console.warn('クリップ音声のデコード失敗:', clip.name, e);
      }
      try {
        const { data, duration } = await getAnalysisAudio(clip.mediaId, clip.file);
        const keep = invertToKeep(
          detectSilences(data, { minSilence: 0.3, sensitivity: 'mid', padding: 0.08 }),
          duration
        );
        for (const k of keep) {
          const s = Math.max(k.start, clip.in), e = Math.min(k.end, clip.out);
          if (e > s) speech.push({ start: tl + (s - clip.in), end: tl + (e - clip.in) });
        }
      } catch { /* 解析できないクリップはダッキング対象外 */ }
    }
    tl += dur;
  }
  const speechMerged = mergeIntervals(speech);

  // 2. 音声トラック（BGM・アテレコ）
  for (const item of tracks) {
    if (!item.file) continue;
    try {
      const decoded = await decode(item.mediaId, item.file);
      const src = octx.createBufferSource();
      src.buffer = decoded;
      const gain = octx.createGain();
      src.connect(gain);
      gain.connect(octx.destination);
      const dur = Math.min(item.duration || decoded.duration, decoded.duration);
      if (item.duck) applyDuck(gain.gain, item, speechMerged);
      else gain.gain.value = item.volume;
      src.start(Math.max(0, item.start), 0, dur);
    } catch (e) {
      console.warn('トラック音声のデコード失敗:', item.name, e);
    }
  }

  return octx.startRendering();
}

// ダッキングのゲイン自動化：声の区間だけ base→ducked に下げ、終わったら戻す
function applyDuck(param, item, speechMerged) {
  const base = item.volume;
  const ducked = item.volume * 0.22;
  const ramp = 0.12;
  const winStart = Math.max(0, item.start);
  const winEnd = item.start + item.duration;
  param.setValueAtTime(base, 0);
  for (const iv of speechMerged) {
    const s = Math.max(iv.start, winStart);
    const e = Math.min(iv.end, winEnd);
    if (e - s <= 0.05) continue;
    param.setValueAtTime(base, Math.max(0, s - ramp));
    param.linearRampToValueAtTime(ducked, s);
    param.setValueAtTime(ducked, Math.max(s, e - ramp));
    param.linearRampToValueAtTime(base, e);
  }
}

// 近い区間（0.3秒以内）はまとめて、ゲイン自動化の時刻が単調増加になるようにする
function mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + 0.3) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export function clearDecodeCache() { decodeCache.clear(); }
