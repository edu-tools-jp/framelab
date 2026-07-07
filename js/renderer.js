// renderer.js — 1フレームの合成処理（映像＋LUT＋タイトル＋字幕）
// プレビュー(player.js)と書き出し(exporter-wc.js)が同じ絵を出すため、ここに一本化する

import { captionAtSource } from './store.js';
import { processFrame } from './glfx.js';
import { drawTitles } from './titles.js';

// ctx/W/H に対して、指定クリップの1フレームを合成描画する。
//  source: 描画元（videoElement か ImageBitmap）
//  srcTime: そのクリップ内のソース時間（字幕の紐付けに使う）
//  timelineTime: タイムライン全体での時間（タイトルのアニメに使う）
export function compositeFrame(ctx, W, H, { project, clip, source, srcTime, timelineTime }) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  let drawSource = source;
  if (source && clip?.lut?.id) {
    const graded = processFrame(source, clip.lut.id, clip.lut.intensity ?? 1);
    if (graded) drawSource = graded;
  }
  if (drawSource) drawContain(ctx, W, H, drawSource);

  drawTitles(ctx, W, H, timelineTime);
  if (clip) drawCaption(ctx, W, H, project, clip, srcTime);
}

// アスペクト比を保って中央に描画（縦プロジェクト×横素材などは黒帯）
export function drawContain(ctx, W, H, source) {
  const sw = source.videoWidth || source.displayWidth || source.width;
  const sh = source.videoHeight || source.displayHeight || source.height;
  if (!sw || !sh) return;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawCaption(ctx, W, H, project, clip, srcTime) {
  const style = project?.subtitleStyle;
  if (!style?.visible) return;
  const seg = captionAtSource(clip.mediaId, srcTime);
  if (!seg) return;

  const px = Math.round(H * style.size);
  const family = style.font === 'serif'
    ? '"Hiragino Mincho ProN", "Yu Mincho", serif'
    : '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.font = `700 ${px}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const lines = wrapText(ctx, seg.text, W * 0.9);
  const lineH = px * 1.35;
  const padY = H * 0.05;
  const baseY = style.position === 'top'
    ? padY + lineH
    : H - padY - (lines.length - 1) * lineH;

  for (let i = 0; i < lines.length; i++) {
    const y = baseY + i * lineH;
    const line = lines[i];
    if (style.bg) {
      const w = ctx.measureText(line).width;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      roundRect(ctx, W / 2 - w / 2 - px * 0.4, y - px * 1.05, w + px * 0.8, px * 1.4, px * 0.2);
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.16;
    ctx.strokeStyle = style.outline;
    ctx.strokeText(line, W / 2, y);
    ctx.fillStyle = style.color;
    ctx.fillText(line, W / 2, y);
  }
}

function wrapText(ctx, text, maxWidth) {
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}
