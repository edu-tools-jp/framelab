// exporter.js — 動画の書き出し（司令塔）
// WebCodecsが使えれば1フレームずつ確実にエンコード（滑らか・推奨）。
// 使えない古い環境では、従来のリアルタイム録画へ自動フォールバックする。

import { state, emit, totalDuration } from './store.js';
import { getCanvas, ensureAudio, play, pause, seek } from './player.js';
import { isWebCodecsExportSupported, exportVideoWC } from './exporter-wc.js';

let recorder = null;
let wakeLock = null;

export function isExportSupported() {
  return isWebCodecsExportSupported() || typeof MediaRecorder !== 'undefined';
}

// 書き出しの司令塔。まずWebCodecsを試し、失敗したらリアルタイム録画へ切り替える。
export async function exportVideo() {
  if (!state.project || !state.project.clips.length) {
    throw new Error('クリップがありません');
  }
  if (isWebCodecsExportSupported()) {
    try {
      state.exporting = true;
      emit('exporting');
      try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
      const result = await exportVideoWC(state.project, {
        onProgress: (p) => emit('export-progress', p),
      });
      return result;
    } catch (e) {
      console.warn('WebCodecs書き出しに失敗、従来方式へ切替:', e);
      // 下のリアルタイム録画へフォールバック
    } finally {
      try { wakeLock?.release(); } catch { }
      wakeLock = null;
      state.exporting = false;
      emit('exporting');
    }
  }
  return exportVideoMediaRecorder();
}

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// 従来方式：プレビュー画面をリアルタイム録画する（WebCodecs非対応環境向けのフォールバック）
async function exportVideoMediaRecorder() {
  if (!state.project || !state.project.clips.length) {
    throw new Error('クリップがありません');
  }
  const canvas = getCanvas();
  const { audioCtx, masterGain } = ensureAudio();
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('この端末では録画形式に対応していません');

  // 画面スリープを防ぐ（対応端末のみ）
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }

  const fps = Math.min(state.project.fps, 60);
  const videoStream = canvas.captureStream(fps);
  const audioDest = audioCtx.createMediaStreamDestination();
  masterGain.connect(audioDest);

  const stream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audioDest.stream.getAudioTracks(),
  ]);

  const pixels = state.project.width * state.project.height;
  const videoBitsPerSecond = pixels > 2100000 ? 45_000_000 : 14_000_000; // 4K / 1080p

  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 192_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  state.exporting = true;
  emit('exporting');

  const total = totalDuration();
  const progressTimer = setInterval(() => {
    emit('export-progress', Math.min(1, state.currentTime / total));
  }, 200);

  try {
    await seek(0);
    recorder.start(1000);

    // タイムライン末尾まで再生し終わるのを待つ
    await new Promise((resolve, reject) => {
      recorder.onerror = (e) => reject(e.error || new Error('録画エラー'));
      play(() => resolve());
    });

    // 最後のフレームを取りこぼさないよう少し待ってから停止
    await new Promise(r => setTimeout(r, 300));
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });

    const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `${state.project.name || 'movie'}.${ext}`;
    return { blob, filename, mimeType };
  } finally {
    clearInterval(progressTimer);
    masterGain.disconnect(audioDest);
    try { wakeLock?.release(); } catch { }
    wakeLock = null;
    recorder = null;
    state.exporting = false;
    emit('exporting');
    pause();
  }
}

export function cancelExport() {
  if (recorder && recorder.state !== 'inactive') {
    pause();
    recorder.stop();
  }
}

// 完成ファイルを保存／共有する（iOSは共有シート→「ビデオを保存」で写真アプリへ）
export async function saveResult({ blob, filename }) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // 共有に失敗したらダウンロードにフォールバック
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
