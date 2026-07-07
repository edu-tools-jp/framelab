// exporter-wc.js — WebCodecsによる高品質書き出し
// タイムラインを1フレームずつ確実に描いてエンコードするため、リアルタイム録画と違い
// クリップの切れ目やLUT処理があってもカクつかない。時間はかかるが滑らかさを保証する。

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';
import { compositeFrame } from './renderer.js';
import { renderProjectAudio } from './audio-mix.js';
import { seekToPaintable } from './importer.js';
import { ensureLutLoaded } from './luts.js';

export function isWebCodecsExportSupported() {
  return typeof VideoEncoder !== 'undefined'
    && typeof AudioEncoder !== 'undefined'
    && typeof VideoFrame !== 'undefined'
    && typeof AudioData !== 'undefined';
}

// H.264（High profile）のコーデック文字列を解像度・fpsから選ぶ
function avcCodec(W, H, fps) {
  const px = W * H;
  let level;
  if (px > 2100000) level = fps > 30 ? 0x34 : 0x33;      // 4K: 5.2 / 5.1
  else if (px > 920000) level = fps > 30 ? 0x2a : 0x28;  // 1080p: 4.2 / 4.0
  else level = 0x1f;                                      // 720p以下: 3.1
  return 'avc1.6400' + level.toString(16).padStart(2, '0');
}

async function checkSupport(W, H, fps) {
  const videoCfg = {
    codec: avcCodec(W, H, fps),
    width: W, height: H,
    bitrate: W * H > 2100000 ? 40_000_000 : 12_000_000,
    framerate: fps,
  };
  const audioCfg = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 };
  const [v, a] = await Promise.all([
    VideoEncoder.isConfigSupported(videoCfg),
    AudioEncoder.isConfigSupported(audioCfg),
  ]);
  return { ok: v.supported && a.supported, videoCfg, audioCfg };
}

// 書き出し実行。onProgress(0..1) で進捗通知。{ blob, filename, mimeType } を返す。
export async function exportVideoWC(project, { onProgress = () => {} } = {}) {
  const W = project.width, H = project.height;
  const fps = Math.min(project.fps || 30, 60);
  const clips = project.clips;
  const totalDur = clips.reduce((s, c) => s + (c.out - c.in), 0);
  if (totalDur <= 0) throw new Error('クリップがありません');
  const totalFrames = Math.max(1, Math.round(totalDur * fps));

  const support = await checkSupport(W, H, fps);
  if (!support.ok) throw new Error('WEBCODECS_UNSUPPORTED');

  onProgress(0.01);

  // 使用中のLUTを先にGPUへ載せておく
  for (const c of clips) {
    if (c.lut?.id) { try { await ensureLutLoaded(c.lut.id); } catch { } }
  }

  // 先に音声をまとめてレンダリング（失敗しても映像だけは出す）
  let audioBuffer = null;
  try {
    audioBuffer = await renderProjectAudio(project, 48000);
  } catch (e) {
    console.warn('音声ミックスに失敗、無音で続行:', e);
  }
  onProgress(0.05);

  // 合成用キャンバス
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  // ミューサー
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: audioBuffer ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 } : undefined,
    fastStart: 'in-memory',
  });

  let encodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  videoEncoder.configure(support.videoCfg);

  // 書き出し用の動画要素を隠して置くコンテナ
  // （iOSは画面外の <video> だとフレーム取得が不安定なため、極小で不可視にしてDOMに置く）
  const hiddenBox = document.createElement('div');
  hiddenBox.style.cssText = 'position:fixed;left:-9999px;top:0;width:16px;height:9px;overflow:hidden;opacity:0;pointer-events:none';
  document.body.appendChild(hiddenBox);

  const videoPool = new Map(); // url -> HTMLVideoElement
  async function getVideo(clip) {
    let v = videoPool.get(clip.url);
    if (v) return v;
    v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = clip.url;
    v.style.cssText = 'width:16px;height:9px';
    hiddenBox.appendChild(v);
    await new Promise((res, rej) => {
      const ok = () => { cleanup(); res(); };
      const ng = () => { cleanup(); rej(new Error('動画を開けません: ' + clip.name)); };
      const cleanup = () => {
        v.removeEventListener('loadeddata', ok);
        v.removeEventListener('error', ng);
      };
      if (v.readyState >= 2) return ok();
      v.addEventListener('loadeddata', ok);
      v.addEventListener('error', ng);
      setTimeout(ok, 8000); // 保険
    });
    videoPool.set(clip.url, v);
    return v;
  }

  // クリップ列を先頭から時系列に走査するためのカーソル
  function clipAtFrame(f) {
    const t = f / fps;
    let acc = 0;
    for (const clip of clips) {
      const dur = clip.out - clip.in;
      if (t < acc + dur - 1e-6 || clip === clips[clips.length - 1]) {
        return { clip, offset: Math.min(Math.max(0, t - acc), dur), timelineTime: t };
      }
      acc += dur;
    }
    return null;
  }

  const usPerFrame = 1e6 / fps;
  const keyEvery = Math.round(fps * 2); // 2秒ごとにキーフレーム

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (encodeError) throw encodeError;
      const hit = clipAtFrame(f);
      if (!hit) break;
      const { clip, offset, timelineTime } = hit;

      let source = null;
      if (clip.kind === 'video') {
        const v = await getVideo(clip);
        await seekToPaintable(v, Math.min(clip.in + offset, (clip.srcDuration || v.duration) - 0.001));
        source = v;
      } else {
        source = clip.bitmap || null;
      }

      compositeFrame(ctx, W, H, {
        project, clip, source,
        srcTime: clip.in + offset,
        timelineTime,
      });

      const frame = new VideoFrame(canvas, { timestamp: Math.round(f * usPerFrame), duration: Math.round(usPerFrame) });
      videoEncoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();

      // エンコーダが詰まったら少し待つ（メモリ肥大の防止）
      while (videoEncoder.encodeQueueSize > 8) {
        await new Promise(r => setTimeout(r, 4));
        if (encodeError) throw encodeError;
      }

      if (f % 3 === 0) onProgress(0.05 + 0.8 * (f / totalFrames));
    }

    await videoEncoder.flush();
    onProgress(0.87);

    // 音声エンコード
    if (audioBuffer) {
      await encodeAudio(muxer, audioBuffer, support.audioCfg, (p) => onProgress(0.87 + 0.1 * p));
    }
    onProgress(0.98);

    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    onProgress(1);
    return { blob, filename: `${project.name || 'movie'}.mp4`, mimeType: 'video/mp4' };
  } finally {
    try { videoEncoder.close(); } catch { }
    for (const v of videoPool.values()) { v.removeAttribute('src'); v.load(); }
    videoPool.clear();
    hiddenBox.remove();
  }
}

async function encodeAudio(muxer, audioBuffer, cfg, onProgress) {
  let error = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { error = e; },
  });
  encoder.configure(cfg);

  const sr = audioBuffer.sampleRate;
  const total = audioBuffer.length;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  const chunk = Math.floor(sr * 0.1); // 100msずつ

  for (let off = 0; off < total; off += chunk) {
    if (error) throw error;
    const n = Math.min(chunk, total - off);
    // f32-planar: [ch0の全サンプル..., ch1の全サンプル...]
    const data = new Float32Array(n * 2);
    data.set(ch0.subarray(off, off + n), 0);
    data.set(ch1.subarray(off, off + n), n);
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: sr,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round(off / sr * 1e6),
      data,
    });
    encoder.encode(ad);
    ad.close();
    if ((off / chunk) % 10 === 0) onProgress(off / total);
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
}
