// whisper-worker.js — 文字起こしAI（Whisper）を別スレッドで動かすワーカー
// UIを固まらせないため、モデルの読み込みと推論はすべてここで行う

const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js';

let tf = null;
let pipe = null;
let loadedModel = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === 'load') {
      await ensurePipeline(msg.model);
      self.postMessage({ type: 'ready' });
    } else if (msg.cmd === 'transcribe') {
      await ensurePipeline(msg.model);
      const result = await transcribe(msg.audio);
      self.postMessage({ type: 'result', id: msg.id, ...result });
    }
  } catch (err) {
    console.error(err);
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};

async function ensurePipeline(model) {
  if (pipe && loadedModel === model) return;
  if (!tf) tf = await import(TRANSFORMERS_CDN);

  // WASM(CPU)実行が標準。WebGPUは環境によって出力が壊れることを確認済みのため使わない。
  // COOP/COEPヘッダが有効な環境（本番のサービスワーカー経由）ではマルチスレッドで高速化される
  if (self.crossOriginIsolated) {
    tf.env.backends.onnx.wasm.numThreads =
      Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  }

  const opts = {
    dtype: 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
        self.postMessage({ type: 'model-progress', file: p.file, progress: p.progress || 0 });
      }
    },
  };
  pipe = await tf.pipeline('automatic-speech-recognition', model, opts);
  loadedModel = model;
}

async function transcribe(audio) {
  const base = { language: 'japanese', task: 'transcribe', chunk_length_s: 30 };
  // まず単語タイムスタンプ付きで試す（フィラー検出に必要）。
  // モデルによっては失敗するので、その場合はセグメント単位で取り直す
  try {
    const out = await pipe(audio, { ...base, return_timestamps: 'word' });
    return { mode: 'word', chunks: sanitize(out) };
  } catch (err) {
    console.warn('単語タイムスタンプ失敗、セグメントで再試行:', err);
    const out = await pipe(audio, { ...base, return_timestamps: true });
    return { mode: 'segment', chunks: sanitize(out) };
  }
}

function sanitize(out) {
  return (out.chunks || [])
    .filter(c => c.text && c.timestamp)
    .map(c => ({
      text: c.text,
      start: Number(c.timestamp[0]) || 0,
      end: Number(c.timestamp[1] ?? c.timestamp[0]) || 0,
    }));
}
