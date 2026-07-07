// persist.js — プロジェクトの自動保存と読み込み
// 編集イベントを購読し、少し待ってからまとめてIndexedDBへ書き込む

import { state, on, emit, totalDuration } from './store.js';
import { idbPut, idbGet, idbDelete, idbGetAll, idbHas } from './db.js';

const savedMedia = new Set(); // このセッションで保存済みのmediaId
let saveTimer = null;
let saving = false;

export function initPersistence() {
  // ブラウザにデータを消さないようお願いする（対応環境のみ）
  try { navigator.storage?.persist?.(); } catch { }

  const schedule = () => {
    if (!state.project) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveNow().catch(err => console.error('自動保存失敗:', err)); }, 800);
  };
  on('clips', schedule);
  on('project', schedule);
  on('transcripts', schedule);
  on('style', schedule);
  on('titles', schedule);
  on('audio', schedule);
}

export async function saveNow() {
  const p = state.project;
  if (!p || saving) return;
  saving = true;
  try {
    // 実ファイルを保存（未保存のものだけ）。クリップと音声トラックの両方
    for (const item of [...p.clips, ...(p.audio || [])]) {
      if (!item.mediaId || !item.file || savedMedia.has(item.mediaId)) continue;
      if (!(await idbHas('media', item.mediaId))) {
        await idbPut('media', {
          id: item.mediaId,
          blob: item.file,
          name: item.name,
          kind: item.kind,
        });
      }
      savedMedia.add(item.mediaId);
    }
    await idbPut('projects', serializeProject(p));
    emit('saved');
  } finally {
    saving = false;
  }
}

function serializeProject(p) {
  return {
    id: p.id,
    name: p.name,
    orientation: p.orientation,
    width: p.width,
    height: p.height,
    fps: p.fps,
    updatedAt: Date.now(),
    duration: totalDuration(),
    thumb: p.clips[0]?.thumbs?.[0] || null,
    mediaIds: [...new Set([
      ...p.clips.map(c => c.mediaId),
      ...(p.audio || []).map(a => a.mediaId),
    ])],
    transcripts: p.transcripts || {},
    subtitleStyle: p.subtitleStyle || null,
    titles: p.titles || [],
    audio: (p.audio || []).map(a => ({
      id: a.id,
      kind: a.kind,
      mediaId: a.mediaId,
      name: a.name,
      start: a.start,
      duration: a.duration,
      volume: a.volume,
      duck: a.duck,
    })),
    clips: p.clips.map(c => ({
      id: c.id,
      kind: c.kind,
      mediaId: c.mediaId,
      name: c.name,
      srcDuration: c.srcDuration === Infinity ? -1 : c.srcDuration,
      in: c.in,
      out: c.out,
      width: c.width,
      height: c.height,
      thumbs: c.thumbs,
      lut: c.lut || null,
    })),
  };
}

// 保存済みプロジェクトの一覧（新しい順）
export async function listProjects() {
  const all = await idbGetAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

// プロジェクトを読み込み、メディアを復元して state に反映できる形で返す
export async function loadProject(id) {
  const rec = await idbGet('projects', id);
  if (!rec) throw new Error('プロジェクトが見つかりません');

  const mediaMap = new Map(); // mediaId -> {file, url, bitmap?}
  for (const mid of rec.mediaIds || []) {
    const m = await idbGet('media', mid);
    if (!m) continue;
    const entry = { file: m.blob, url: URL.createObjectURL(m.blob) };
    if (m.kind === 'photo') {
      try { entry.bitmap = await createImageBitmap(m.blob); } catch { }
    }
    mediaMap.set(mid, entry);
    savedMedia.add(mid);
  }

  const clips = [];
  const missing = [];
  for (const c of rec.clips) {
    const m = mediaMap.get(c.mediaId);
    if (!m) { missing.push(c.name); continue; }
    clips.push({
      ...c,
      srcDuration: c.srcDuration < 0 ? Infinity : c.srcDuration,
      file: m.file,
      url: m.url,
      bitmap: m.bitmap,
    });
  }

  // 音声トラック（BGM・アテレコ）の復元
  const audio = [];
  for (const a of rec.audio || []) {
    const m = mediaMap.get(a.mediaId);
    if (!m) { missing.push(a.name); continue; }
    audio.push({ ...a, file: m.file, url: m.url });
  }

  return {
    project: {
      id: rec.id,
      name: rec.name,
      orientation: rec.orientation,
      width: rec.width,
      height: rec.height,
      fps: rec.fps,
      clips,
      transcripts: rec.transcripts || {},
      subtitleStyle: rec.subtitleStyle || null,
      titles: rec.titles || [],
      audio,
    },
    missing,
  };
}

export async function deleteProject(id) {
  const rec = await idbGet('projects', id);
  if (rec) {
    for (const mid of rec.mediaIds || []) {
      await idbDelete('media', mid);
      savedMedia.delete(mid);
    }
  }
  await idbDelete('projects', id);
}
