// store.js — アプリ全体の状態管理とタイムライン計算
// すべてのUI部品はここの state を読み、変更は必ずここの関数経由で行う

const listeners = new Map();

export function on(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
}

export function emit(ev, data) {
  const set = listeners.get(ev);
  if (set) for (const fn of set) fn(data);
}

export const state = {
  project: null,        // { name, orientation, width, height, fps, clips: [] }
  selectedClipId: null,
  currentTime: 0,       // タイムライン上の再生位置（秒）
  playing: false,
  exporting: false,
  pxPerSec: 60,         // タイムラインの拡大率
};

let idSeq = 1;
export function newId() { return 'c' + (idSeq++) + '_' + Math.random().toString(36).slice(2, 7); }

// ---- プロジェクト ----

export function defaultSubtitleStyle() {
  return {
    visible: true,
    size: 0.05,        // canvas高さに対する文字サイズの割合
    position: 'bottom',
    color: '#ffffff',
    outline: '#000000',
    bg: false,
    font: 'sans',
  };
}

export function createProject({ name, orientation, width, height, fps }) {
  state.project = {
    id: newId(),
    name, orientation, width, height, fps,
    clips: [],
    transcripts: {},                   // mediaId -> { segments: [...], words: [...] }
    subtitleStyle: defaultSubtitleStyle(),
    titles: [],                        // タイトル [{id, templateId, text, start, duration}]
    audio: [],                         // 音声トラック [{id, kind, mediaId, name, start, duration, volume, duck}]
  };
  state.selectedClipId = null;
  state.currentTime = 0;
  undoStack.length = 0;
  emit('project');
  emit('clips');
  emit('time');
}

// 保存データから復元したプロジェクトをそのまま反映する
export function setProject(project) {
  if (!project.subtitleStyle) project.subtitleStyle = defaultSubtitleStyle();
  if (!project.transcripts) project.transcripts = {};
  if (!project.titles) project.titles = [];
  if (!project.audio) project.audio = [];
  state.project = project;
  state.selectedClipId = null;
  state.currentTime = 0;
  undoStack.length = 0;
  emit('project');
  emit('clips');
  emit('time');
  emit('select');
}

// ---- クリップ計算 ----
// clip: { id, kind:'video'|'photo', file, url, name, srcDuration, in, out,
//         width, height, thumbs:[dataURL], bitmap? }

export function clipDuration(c) { return c.out - c.in; }

export function totalDuration() {
  if (!state.project) return 0;
  return state.project.clips.reduce((s, c) => s + clipDuration(c), 0);
}

export function clipStartTime(clip) {
  let t = 0;
  for (const c of state.project.clips) {
    if (c.id === clip.id) return t;
    t += clipDuration(c);
  }
  return t;
}

// タイムライン位置 t にあるクリップを返す
export function findClipAt(t) {
  if (!state.project) return null;
  let acc = 0;
  for (let i = 0; i < state.project.clips.length; i++) {
    const c = state.project.clips[i];
    const d = clipDuration(c);
    if (t < acc + d || i === state.project.clips.length - 1 && t <= acc + d + 0.0001) {
      if (t <= acc + d) return { clip: c, offset: Math.max(0, t - acc), index: i, start: acc };
    }
    acc += d;
  }
  return null;
}

// ---- 取り消し（undo）----
// クリップ配列のスナップショット方式。分割・削除・自動カットなどの前に積む

const undoStack = [];
const UNDO_MAX = 20;

export function pushUndo(label) {
  if (!state.project) return;
  undoStack.push({ label, clips: state.project.clips.map(c => ({ ...c })) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  emit('undo');
}

export function undo() {
  const snap = undoStack.pop();
  if (!snap || !state.project) return null;
  state.project.clips = snap.clips;
  state.selectedClipId = null;
  clampTime();
  emit('clips');
  emit('select');
  emit('undo');
  return snap.label;
}

export function canUndo() { return undoStack.length > 0; }

// ---- クリップ操作 ----

export function addClips(clips) {
  state.project.clips.push(...clips);
  emit('clips');
}

export function removeClip(id) {
  const i = state.project.clips.findIndex(c => c.id === id);
  if (i < 0) return;
  pushUndo('クリップ削除');
  state.project.clips.splice(i, 1);
  if (state.selectedClipId === id) state.selectedClipId = null;
  clampTime();
  emit('clips');
  emit('select');
}

export function splitAt(t) {
  const hit = findClipAt(t);
  if (!hit) return false;
  const { clip, offset, index } = hit;
  // 端ぎりぎりでの分割は無視（0.05秒未満の断片を作らない）
  if (offset < 0.05 || clipDuration(clip) - offset < 0.05) return false;
  pushUndo('分割');
  const right = { ...clip, id: newId(), in: clip.in + offset };
  clip.out = clip.in + offset;
  state.project.clips.splice(index + 1, 0, right);
  emit('clips');
  return true;
}

// クリップ列をまるごと置き換える（ジェットカットなどの一括編集用）
export function replaceClips(newClips, label) {
  pushUndo(label || '一括編集');
  state.project.clips = newClips;
  state.selectedClipId = null;
  clampTime();
  emit('clips');
  emit('select');
}

export function moveClip(id, dir) {
  const clips = state.project.clips;
  const i = clips.findIndex(c => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= clips.length) return;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  emit('clips');
}

// ---- 再生位置・選択 ----

export function setTime(t) {
  state.currentTime = Math.max(0, Math.min(t, totalDuration()));
  emit('time');
}

function clampTime() {
  state.currentTime = Math.max(0, Math.min(state.currentTime, totalDuration()));
  emit('time');
}

export function setSelected(id) {
  state.selectedClipId = id;
  emit('select');
}

export function setPlaying(v) {
  state.playing = v;
  emit('playing');
}

// ---- 字幕（文字起こし）----
// 字幕は「素材（mediaId）のソース時間」に紐づける。
// こうするとカット編集や並べ替えをしても字幕が自動で追従する。

export function setTranscript(mediaId, data) {
  state.project.transcripts[mediaId] = data;
  emit('transcripts');
}

export function getTranscript(mediaId) {
  return state.project?.transcripts?.[mediaId] || null;
}

export function hasAnyTranscript() {
  return !!state.project && Object.keys(state.project.transcripts).length > 0;
}

export function updateSegmentText(mediaId, segId, text) {
  const t = getTranscript(mediaId);
  const seg = t?.segments?.find(s => s.id === segId);
  if (!seg) return;
  seg.text = text;
  emit('transcripts');
}

export function deleteSegment(mediaId, segId) {
  const t = getTranscript(mediaId);
  if (!t?.segments) return;
  t.segments = t.segments.filter(s => s.id !== segId);
  emit('transcripts');
}

// ソース時間 t に表示すべき字幕を返す
export function captionAtSource(mediaId, t) {
  const tr = state.project?.transcripts?.[mediaId];
  if (!tr?.segments) return null;
  return tr.segments.find(s => t >= s.start && t < s.end) || null;
}

export function setSubtitleStyle(patch) {
  Object.assign(state.project.subtitleStyle, patch);
  emit('style');
}

// ---- 表示ユーティリティ ----

export function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${f}`;
}
