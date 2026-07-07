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
    const videoSamples = [];
    const audioSamples = [];
    let video = null, audio = null, vId = -1, aId = -1;

    mp4.onError = (e) => reject(new Error('分解に失敗: ' + e));
    mp4.onReady = (info) => {
      const vt = info.videoTracks && info.videoTracks[0];
      if (!vt) return reject(new Error('映像トラックがありません'));
      vId = vt.id;
      video = {
        trackId: vt.id, codec: vt.codec,
        width: vt.video.width, height: vt.video.height,
        description: getVideoDescription(mp4, vt.id),
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: Infinity });

      // 音声トラックも同じ1回の分解で取り出す（iOSの decodeAudioData 不発を避けるため）
      const at = info.audioTracks && info.audioTracks[0];
      if (at) {
        aId = at.id;
        audio = {
          trackId: at.id, codec: at.codec,
          sampleRate: at.audio.sample_rate,
          numberOfChannels: at.audio.channel_count,
          description: getAudioDescription(mp4, at.id),
        };
        mp4.setExtractionOptions(at.id, null, { nbSamples: Infinity });
      }
      mp4.start();
    };
    mp4.onSamples = (id, user, s) => {
      const dest = id === aId ? audioSamples : videoSamples;
      for (const smp of s) dest.push(smp);
    };

    file.arrayBuffer().then((ab) => {
      ab.fileStart = 0;
      mp4.appendBuffer(ab);
      mp4.flush();
      if (!video) return reject(new Error('動画情報を読めませんでした'));
      const result = { video, audio, videoSamples, audioSamples };
      if (mediaId) demuxCache.set(mediaId, result);
      resolve(result);
    }).catch(reject);
  });
}

// VideoDecoder.configure に渡す avcC/hvcC などの記述子を取り出す
function getVideoDescription(mp4file, trackId) {
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

// AudioDecoder用の記述子（AACのAudioSpecificConfig）を esds ボックスから取り出す。
// MPEG-4記述子のうち DecoderSpecificInfo（tag=0x05）の中身が ASC 本体。
// tag=0x06(SLConfig)等の別記述子を掴まないよう、tagを厳密に判定する。
function getAudioDescription(mp4file, trackId) {
  try {
    const trak = mp4file.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const esds = entry && entry.esds;
    if (!esds || !esds.esd) return undefined;
    const stack = [...(esds.esd.descs || [])];
    while (stack.length) {
      const d = stack.shift();
      if (d.tag === 0x05 && d.data && d.data.length) return new Uint8Array(d.data); // DecoderSpecificInfo
      if (d.descs) stack.push(...d.descs);
    }
  } catch { }
  return undefined;
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
    this.samples = dem.videoSamples;
    this.decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      error: (e) => { this.error = e; this._drainWaiters(); },
    });
    this.decoder.configure({
      codec: dem.video.codec,
      codedWidth: dem.video.width,
      codedHeight: dem.video.height,
      description: dem.video.description,
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

export function isAudioDecodeSupported() {
  return typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined';
}

// AAC-LCのAudioSpecificConfig(ASC)を、サンプルレートとチャンネル数から組み立てる。
// iPhoneの.movはコンテナ内にesds記述子が無いことがあり、その場合の代替として使う。
const AAC_FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function buildAacAsc(sampleRate, channels) {
  let freqIdx = AAC_FREQ_TABLE.indexOf(sampleRate);
  if (freqIdx < 0) freqIdx = 4; // 不明なら44100扱い
  const objType = 2; // AAC-LC
  const chCfg = Math.min(Math.max(channels || 2, 1), 7);
  const b0 = (objType << 3) | (freqIdx >> 1);
  const b1 = ((freqIdx & 1) << 7) | (chCfg << 3);
  return new Uint8Array([b0, b1]);
}

// 動画ファイルの音声トラックをPCMに復号して返す（iOSで確実に音声を取り出すための本命）。
// 返り値 { channels:[Float32Array,...], sampleRate, numberOfChannels, duration } / 音声無しは null
export async function decodeAudioPCM(file, mediaId) {
  if (!isAudioDecodeSupported()) return null;
  const dem = await demux(file, mediaId);
  if (!dem.audio || !dem.audioSamples.length) return null;

  // コーデック文字列を正規化（.movは "mp4a" とだけ報告されることがある → AAC-LCとして扱う）
  let codec = dem.audio.codec || '';
  if (codec === 'mp4a' || codec === 'aac' || codec.startsWith('mp4a.40')) {
    if (!codec.startsWith('mp4a.40')) codec = 'mp4a.40.2';
  }
  // 記述子(ASC)：コンテナから取れなければ、サンプルレート/チャンネルから組み立てる
  const description = dem.audio.description ||
    ((codec.startsWith('mp4a.40')) ? buildAacAsc(dem.audio.sampleRate, dem.audio.numberOfChannels) : undefined);

  const config = {
    codec,
    sampleRate: dem.audio.sampleRate,
    numberOfChannels: dem.audio.numberOfChannels,
  };
  if (description) config.description = description;

  const sup = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!sup.supported) return null;

  const out = [];
  let error = null;
  const dec = new AudioDecoder({
    output: (data) => out.push(data),
    error: (e) => { error = e; },
  });
  dec.configure(config);
  for (const s of dem.audioSamples) {
    dec.decode(new EncodedAudioChunk({
      type: 'key', // 音声フレームは全てキー
      timestamp: Math.round(s.cts / s.timescale * 1e6),
      duration: Math.round((s.duration || 0) / s.timescale * 1e6),
      data: s.data,
    }));
  }
  await dec.flush();
  dec.close();
  if (error) throw error;
  if (!out.length) return null;

  const nCh = out[0].numberOfChannels || dem.audio.numberOfChannels;
  const sr = out[0].sampleRate || dem.audio.sampleRate;
  let total = 0;
  for (const d of out) total += d.numberOfFrames;
  const channels = [];
  for (let c = 0; c < nCh; c++) channels.push(new Float32Array(total));

  let off = 0;
  for (const d of out) {
    const n = d.numberOfFrames;
    for (let c = 0; c < nCh; c++) {
      const tmp = new Float32Array(n);
      try {
        d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      } catch {
        // planar非対応なら interleaved から間引く
        const inter = new Float32Array(n * nCh);
        d.copyTo(inter, { planeIndex: 0, format: 'f32' });
        for (let i = 0; i < n; i++) tmp[i] = inter[i * nCh + c];
      }
      channels[c].set(tmp, off);
    }
    off += n;
    d.close();
  }
  return { channels, sampleRate: sr, numberOfChannels: nCh, duration: total / sr };
}

export function clearDemuxCache() {
  demuxCache.clear();
}
