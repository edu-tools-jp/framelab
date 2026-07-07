// importer.js — 写真アプリ／ファイルから動画・写真を読み込み、クリップ化する

import { newId, addClips, emit } from './store.js';

const THUMB_W = 160;
const THUMB_H = 90;
const PHOTO_DEFAULT_DURATION = 3; // 写真クリップの初期表示秒数

// File[] を受け取ってクリップ配列を作り、タイムラインへ追加する
export async function importFiles(files) {
  const clips = [];
  for (const file of files) {
    try {
      emit('import-progress', { name: file.name });
      if (file.type.startsWith('video')) {
        clips.push(await buildVideoClip(file));
      } else if (file.type.startsWith('image')) {
        clips.push(await buildPhotoClip(file));
      }
    } catch (err) {
      console.error('読み込み失敗:', file.name, err);
      emit('import-error', { name: file.name, error: err });
    }
  }
  if (clips.length) addClips(clips);
  emit('import-done');
  return clips;
}

// iOS Safari対策：一度も再生していない/画面に無い<video>はフレームをデコードしないため、
// canvasに描くと真っ黒になる。そこで「画面内に極小・ほぼ透明で置く」＋「muted再生で
// デコードを起動する」ことで、シークしたフレームを確実に取り込めるようにする。
export function attachDecodableVideo(video) {
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  // 右下に2px・ほぼ透明で配置（opacity:0やdisplay:noneだとiOSがデコードを省略する）
  video.style.cssText =
    'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;z-index:2147483647;pointer-events:none;border:0;background:#000';
  if (!video.isConnected) document.body.appendChild(video);
}

// muted再生でデコードパイプラインを起動する（iOSでdrawImageが黒くならないための肝）
export async function primeVideo(video) {
  try {
    await video.play();
    return true;
  } catch {
    return false;
  }
}

async function buildVideoClip(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  attachDecodableVideo(video);
  video.src = url;

  await eventOnce(video, 'loadedmetadata', 15000);
  let duration = video.duration;
  // iOSのストリーム系ファイルで duration が Infinity になる場合の回避策
  if (!isFinite(duration)) {
    video.currentTime = 1e7;
    await eventOnce(video, 'seeked', 10000).catch(() => {});
    duration = isFinite(video.duration) ? video.duration : video.currentTime;
    video.currentTime = 0;
  }

  const clip = {
    id: newId(),
    kind: 'video',
    mediaId: newId(), // 保存用の実ファイルID。分割してもコピーしても同じ値を共有する
    file, url,
    name: file.name.replace(/\.[^.]+$/, ''),
    srcDuration: duration,
    in: 0,
    out: duration,
    width: video.videoWidth,
    height: video.videoHeight,
    thumbs: [],
  };

  // デコードを起動してからサムネイルを取り出す
  await primeVideo(video);
  clip.thumbs = await extractThumbs(video, duration);
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
  return clip;
}

async function buildPhotoClip(file) {
  const url = URL.createObjectURL(file);
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W; canvas.height = THUMB_H;
  drawCover(canvas.getContext('2d'), bitmap, THUMB_W, THUMB_H);
  return {
    id: newId(),
    kind: 'photo',
    mediaId: newId(),
    file, url,
    name: file.name.replace(/\.[^.]+$/, ''),
    srcDuration: Infinity,
    in: 0,
    out: PHOTO_DEFAULT_DURATION,
    width: bitmap.width,
    height: bitmap.height,
    thumbs: [canvas.toDataURL('image/jpeg', 0.6)],
    bitmap,
  };
}

// 動画から数枚のサムネイルを取り出す（タイムライン表示用）
async function extractThumbs(video, duration) {
  const count = Math.min(8, Math.max(1, Math.ceil(duration / 3)));
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W; canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');
  const thumbs = [];
  for (let i = 0; i < count; i++) {
    const t = duration * (i + 0.5) / count;
    try {
      await seekToPaintable(video, Math.min(t, Math.max(0, duration - 0.1)));
      drawCover(ctx, video, THUMB_W, THUMB_H);
      thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
    } catch {
      break; // サムネイルが取れなくても読み込み自体は続行
    }
  }
  return thumbs;
}

// 指定時刻へシークし、そのフレームが「実際に描画可能」になるまで待つ。
// 手順: currentTime設定 → 'seeked' → 提示フレーム(rVFC)を1枚待つ。
// これで iOS でも drawImage が黒くならない（デコード起動は attachDecodableVideo+primeVideo が担当）
export function seekToPaintable(video, t) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const timer = setTimeout(finish, 4000); // 保険：待ちすぎない
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('error', finish);
      video.removeEventListener('seeked', onSeeked);
    };
    const waitFrame = () => {
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => finish());
      else requestAnimationFrame(() => requestAnimationFrame(finish));
    };
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); waitFrame(); };

    video.addEventListener('error', finish, { once: true });

    if (Math.abs(video.currentTime - t) < 0.001) {
      // すでにその位置にいる場合は seeked が発火しないので、そのまま1フレーム待つ
      waitFrame();
    } else {
      video.addEventListener('seeked', onSeeked);
      try { video.currentTime = t; } catch { finish(); }
    }
  });
}

function drawCover(ctx, source, w, h) {
  const sw = source.videoWidth || source.width;
  const sh = source.videoHeight || source.height;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function eventOnce(el, ev, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${ev} がタイムアウトしました`));
    }, timeoutMs);
    const onEv = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('メディアの読み込みに失敗しました')); };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(ev, onEv);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(ev, onEv);
    el.addEventListener('error', onErr);
  });
}
