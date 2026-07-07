// decode.js — 動画ファイルを「先頭から連続デコード」してフレームを順番に取り出す。
// シークを使わないので、書き出しがハードウェアデコード速度（＝再生より速い）で進む。
// mp4box.js でMP4/MOVを分解 → WebCodecsのVideoDecoderで復号。

import { createFile, DataStream } from './vendor/mp4box.mjs';

const demuxCache = new Map(); // mediaId -> { codec, width, height, description, samples }

export function isDecodeSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

// ファイルを分解して、デコーダ設定＋全サンプル（符号化フレーム）を得る
function demux(file, mediaId) {
  if (mediaId && demuxCache.has(mediaId)) return Promise.resolve(demuxCache.get(mediaId));
  return new Promise((resolve, reject) => {
    const mp4 = createFile();
    const samples = [];
    let meta = null;

    mp4.onError = (e) => reject(new Error('分解に失敗: ' + e));
    mp4.onReady = (info) => {
      const vt = info.videoTracks && info.videoTracks[0];
      if (!vt) return reject(new Error('映像トラックがありません'));
      meta = {
        trackId: vt.id,
        codec: vt.codec,
        width: vt.video.width,
        height: vt.video.height,
        description: getDescription(mp4, vt.id),
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: Infinity });
      mp4.start();
    };
    mp4.onSamples = (id, user, s) => { for (const smp of s) samples.push(smp); };

    file.arrayBuffer().then((ab) => {
      const buf = ab; // ArrayBuffer
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();
      if (!meta) return reject(new Error('動画情報を読めませんでした'));
      const result = { ...meta, samples };
      if (mediaId) demuxCache.set(mediaId, result);
      resolve(result);
    }).catch(reject);
  });
}

// VideoDecoder.configure に渡す avcC/hvcC などの記述子を取り出す
function getDescription(mp4file, trackId) {
  const trak = mp4file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.av1C || entry.vpcC;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // 先頭8バイト(ボックスヘッダ)を除く
    }
  }
  return undefined; // 記述子不要のコーデックもある
}

// 1クリップぶんの連続デコーダ。pull() でフレームを順番に取り出す。
export class ClipDecoder {
  constructor(file, mediaId) {
    this.file = file;
    this.mediaId = mediaId;
    this.frames = [];    // 復号済みフレーム（表示順）
    this.waiters = [];   // pull() の待ち行列
    this.si = 0;
    this.eof = false;
    this.error = null;
    this._flushing = false;
  }

  async init(startTimeSec = 0) {
    const dem = await demux(this.file, this.mediaId);
    this.samples = dem.samples;
    this.decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      error: (e) => { this.error = e; this._drainWaiters(); },
    });
    this.decoder.configure({
      codec: dem.codec,
      codedWidth: dem.width,
      codedHeight: dem.height,
      description: dem.description,
    });
    // startTimeSec 直前のキーフレームから開始（トリム済みクリップの無駄デコードを減らす）
    this.si = this._findStartIndex(startTimeSec);
  }

  _findStartIndex(t) {
    let idx = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.is_sync && (s.cts / s.timescale) <= t) idx = i;
      if ((s.cts / s.timescale) > t) break;
    }
    return idx;
  }

  _onFrame(frame) {
    if (this.waiters.length) this.waiters.shift()(frame);
    else this.frames.push(frame);
  }

  _drainWaiters() {
    while (this.waiters.length) this.waiters.shift()(null);
  }

  _feed() {
    while (this.si < this.samples.length && this.decoder.decodeQueueSize < 8) {
      const s = this.samples[this.si++];
      this.decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(s.cts / s.timescale * 1e6),
        duration: Math.round((s.duration || 0) / s.timescale * 1e6),
        data: s.data,
      }));
    }
    if (this.si >= this.samples.length && !this._flushing) {
      this._flushing = true;
      this.decoder.flush()
        .then(() => { this.eof = true; this._drainWaiters(); })
        .catch((e) => { this.error = e; this._drainWaiters(); });
    }
  }

  // 次のフレーム（表示順・timestampはマイクロ秒）を返す。終端で null。
  async pull() {
    if (this.error) throw this.error;
    if (this.frames.length) return this.frames.shift();
    if (this.eof) return null;
    this._feed();
    if (this.frames.length) return this.frames.shift();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  close() {
    try { this.decoder && this.decoder.state !== 'closed' && this.decoder.close(); } catch { }
    for (const f of this.frames) { try { f.close(); } catch { } }
    this.frames = [];
    this.waiters = [];
  }
}

export function clearDemuxCache() {
  demuxCache.clear();
}
