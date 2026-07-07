// jetcut.js — 自動ジェットカット
// 無音区間（＋オプションでフィラー）を検出し、クリップを一括カットする。
// 「解析 → 結果を見て → 適用」の2段階方式。適用後は「戻す」で取り消せる。

import { state, newId, replaceClips, clipDuration, hasAnyTranscript } from './store.js';
import { getAnalysisAudio, detectSilences, invertToKeep } from './audio.js';
import { fillerIntervals } from './subtitles.js';
import { refreshFrame } from './player.js';

const $ = (s) => document.querySelector(s);

let lastPlan = null; // 解析結果 { newClips, cutCount, cutSeconds }

export function initJetcutUI(toast) {
  const modal = $('#jetcut-modal');

  $('#btn-jetcut').addEventListener('click', () => {
    lastPlan = null;
    $('#jetcut-result').textContent = '';
    $('#btn-jetcut-apply').disabled = true;
    $('#jetcut-filler').disabled = !hasAnyTranscript();
    $('#jetcut-filler-hint').style.display = hasAnyTranscript() ? 'none' : 'block';
    modal.classList.add('open');
  });
  $('#jetcut-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  // スライダーの値表示
  const minSil = $('#jetcut-minsil');
  minSil.addEventListener('input', () => {
    $('#jetcut-minsil-val').textContent = Number(minSil.value).toFixed(1) + '秒';
  });
  const pad = $('#jetcut-pad');
  pad.addEventListener('input', () => {
    $('#jetcut-pad-val').textContent = (Number(pad.value) * 1000).toFixed(0) + 'ms';
  });

  for (const b of document.querySelectorAll('[data-sens]')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('[data-sens]')) x.classList.toggle('on', x === b);
    });
  }

  $('#btn-jetcut-analyze').addEventListener('click', async () => {
    const btn = $('#btn-jetcut-analyze');
    btn.disabled = true;
    btn.textContent = '解析中…';
    try {
      lastPlan = await analyze({
        minSilence: Number(minSil.value),
        sensitivity: document.querySelector('[data-sens].on')?.dataset.sens || 'mid',
        padding: Number(pad.value),
        cutFillers: $('#jetcut-filler').checked && hasAnyTranscript(),
      });
      const { cutCount, cutSeconds, totalSeconds } = lastPlan;
      if (cutCount === 0) {
        $('#jetcut-result').textContent = 'カットできる箇所は見つかりませんでした。感度を上げるか、無音の長さを短くしてみてください。';
        $('#btn-jetcut-apply').disabled = true;
      } else {
        const pct = totalSeconds ? (cutSeconds / totalSeconds * 100).toFixed(0) : 0;
        $('#jetcut-result').textContent =
          `${cutCount}箇所カットできます（合計 ${cutSeconds.toFixed(1)}秒短縮・全体の${pct}%）`;
        $('#btn-jetcut-apply').disabled = false;
      }
    } catch (err) {
      console.error(err);
      $('#jetcut-result').textContent = '解析に失敗しました: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '解析する';
    }
  });

  $('#btn-jetcut-apply').addEventListener('click', () => {
    if (!lastPlan) return;
    replaceClips(lastPlan.newClips, 'ジェットカット');
    modal.classList.remove('open');
    refreshFrame();
    toast(`${lastPlan.cutCount}箇所カットしました（${lastPlan.cutSeconds.toFixed(1)}秒短縮）。「戻す」で取り消せます`);
  });
}

// 全クリップを解析して、新しいクリップ列（カット適用後）を組み立てる
async function analyze({ minSilence, sensitivity, padding, cutFillers }) {
  const clips = state.project.clips;

  // 素材ごとに一度だけ検出（同じ動画から分割された複数クリップで再利用）
  const cutMapByMedia = new Map(); // mediaId -> intervals[]
  for (const clip of clips) {
    if (clip.kind !== 'video' || cutMapByMedia.has(clip.mediaId)) continue;
    let intervals = [];
    try {
      const { data } = await getAnalysisAudio(clip.mediaId, clip.file);
      intervals = detectSilences(data, { minSilence, sensitivity, padding });
    } catch (err) {
      console.warn('音声解析できないクリップはスキップ:', clip.name, err);
    }
    if (cutFillers) {
      intervals = mergeIntervals([...intervals, ...fillerIntervals(clip.mediaId)]);
    }
    cutMapByMedia.set(clip.mediaId, intervals);
  }

  const newClips = [];
  let cutCount = 0;
  let cutSeconds = 0;
  let totalSeconds = 0;

  for (const clip of clips) {
    totalSeconds += clipDuration(clip);
    if (clip.kind !== 'video') { newClips.push(clip); continue; }
    const cuts = (cutMapByMedia.get(clip.mediaId) || [])
      .map(iv => ({ start: Math.max(iv.start, clip.in), end: Math.min(iv.end, clip.out) }))
      .filter(iv => iv.end - iv.start > 0.05);

    if (!cuts.length) { newClips.push(clip); continue; }

    // クリップ内の「残す区間」を計算してサブクリップ化
    const local = cuts.map(iv => ({ start: iv.start - clip.in, end: iv.end - clip.in }));
    const keeps = invertToKeep(local, clipDuration(clip)).filter(k => k.end - k.start >= 0.12);

    cutCount += cuts.length;
    cutSeconds += clipDuration(clip) - keeps.reduce((s, k) => s + (k.end - k.start), 0);

    for (const k of keeps) {
      newClips.push({ ...clip, id: newId(), in: clip.in + k.start, out: clip.in + k.end });
    }
  }

  return { newClips, cutCount, cutSeconds, totalSeconds };
}

function mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + 0.02) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}
