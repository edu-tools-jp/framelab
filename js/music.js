// music.js — BGM挿入・自動ダッキング・アテレコ録音のUI
// 音声トラックの再生同期そのものは player.js が担当する

import { state, on, emit, newId, fmtTime } from './store.js';
import { play, pause, seek, setMasterMuted } from './player.js';

const $ = (s) => document.querySelector(s);

let recorder = null;
let recStream = null;
let recStartPos = 0;
let recTimer = null;

export function initMusicUI(toast) {
  const modal = $('#music-modal');

  $('#btn-music').addEventListener('click', () => {
    renderTrackList();
    modal.classList.add('open');
  });
  $('#music-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  // ---- BGM追加（ファイル選択）----
  const input = $('#audio-file-input');
  $('#btn-music-add').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files.length) return;
    const files = [...input.files];
    input.value = '';
    for (const file of files) {
      try {
        const item = await buildAudioItem(file, 'bgm');
        item.start = 0;
        item.volume = 0.3; // BGMは声より小さめが基本
        item.duck = true;
        state.project.audio.push(item);
      } catch (err) {
        console.error(err);
        toast(`読み込めませんでした: ${file.name}`);
      }
    }
    emit('audio');
    renderTrackList();
    toast('BGMを追加しました（音量とダッキングは一覧で調整）');
  });

  // ---- アテレコ録音 ----
  $('#btn-rec-start').addEventListener('click', () => startRecording(toast));
  $('#btn-rec-stop').addEventListener('click', () => stopRecording(toast));

  on('project', renderTrackList);
  on('audio', renderTrackList);
}

async function buildAudioItem(file, kind) {
  const url = URL.createObjectURL(file);
  const el = new Audio();
  el.preload = 'metadata';
  el.src = url;
  const duration = await new Promise((res, rej) => {
    el.onloadedmetadata = () => res(el.duration);
    el.onerror = () => rej(new Error('音声を読み込めません'));
    setTimeout(() => rej(new Error('読み込みタイムアウト')), 10000);
  });
  return {
    id: newId(),
    kind,
    mediaId: newId(),
    file, url,
    name: file.name.replace(/\.[^.]+$/, ''),
    start: state.currentTime,
    duration: isFinite(duration) ? duration : 0,
    volume: 1.0,
    duck: false,
  };
}

// ---- 録音（外部マイクはiOS側で自動的に既定入力になる）----

async function startRecording(toast) {
  if (recorder) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    console.error(err);
    toast('マイクを使用できません。設定でマイクの許可を確認してください');
    return;
  }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
  recStream = stream;
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    setMasterMuted(false);
    pause();
    clearInterval(recTimer);
    $('#rec-live').style.display = 'none';
    $('#btn-rec-start').style.display = 'inline-block';
    try {
      const blob = new Blob(chunks, { type: mime.split(';')[0] || 'audio/webm' });
      const ext = mime.includes('mp4') ? 'm4a' : 'webm';
      const file = new File([blob], `アテレコ_${fmtTime(recStartPos).slice(0, 5).replace(':', '-')}.${ext}`, { type: blob.type });
      const item = await buildAudioItem(file, 'rec');
      item.start = recStartPos;
      state.project.audio.push(item);
      emit('audio');
      renderTrackList();
      await seek(recStartPos);
      toast('録音をトラックに追加しました');
    } catch (err) {
      console.error(err);
      toast('録音の保存に失敗しました');
    }
    recorder = null;
    recStream = null;
  };

  // 映像を見ながら録れるよう再生する。スピーカー音がマイクに回り込まないよう本編は消音
  recStartPos = state.currentTime;
  setMasterMuted(true);
  recorder.start();
  play();

  $('#btn-rec-start').style.display = 'none';
  $('#rec-live').style.display = 'flex';
  const t0 = Date.now();
  recTimer = setInterval(() => {
    $('#rec-elapsed').textContent = fmtTime((Date.now() - t0) / 1000);
  }, 100);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

// ---- トラック一覧 ----

function renderTrackList() {
  const list = $('#music-list');
  if (!list || !state.project) return;
  list.innerHTML = '';
  const tracks = state.project.audio || [];
  if (!tracks.length) {
    list.innerHTML = '<p class="hint">音声トラックはまだありません。BGMを追加するか、アテレコを録音してください。</p>';
    return;
  }
  for (const item of tracks) {
    const row = document.createElement('div');
    row.className = 'track-row';

    const head = document.createElement('div');
    head.className = 'track-head';
    const icon = item.kind === 'rec' ? '🎙' : '♪';
    head.innerHTML = `<b>${icon} ${escapeHtml(item.name)}</b>
      <small>${fmtTime(item.start).slice(0, 5)} から ・ ${fmtTime(item.duration).slice(0, 5)}</small>`;

    const del = document.createElement('button');
    del.className = 'cap-del';
    del.textContent = '×';
    del.addEventListener('click', () => {
      state.project.audio = state.project.audio.filter(a => a.id !== item.id);
      emit('audio');
      renderTrackList();
    });
    head.appendChild(del);

    const controls = document.createElement('div');
    controls.className = 'track-controls';

    const volWrap = document.createElement('label');
    volWrap.className = 'track-vol';
    volWrap.textContent = '音量';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = 0; vol.max = 1; vol.step = 0.05;
    vol.value = item.volume;
    vol.addEventListener('input', () => {
      item.volume = Number(vol.value);
      emit('audio');
    });
    volWrap.appendChild(vol);

    const duckWrap = document.createElement('label');
    duckWrap.className = 'check-row compact';
    const duck = document.createElement('input');
    duck.type = 'checkbox';
    duck.checked = item.duck;
    duck.addEventListener('change', () => {
      item.duck = duck.checked;
      emit('audio');
    });
    duckWrap.append(duck, document.createTextNode('声のあいだ音量を下げる'));

    const startBtn = document.createElement('button');
    startBtn.className = 'btn mini';
    startBtn.textContent = '開始をここに';
    startBtn.addEventListener('click', () => {
      item.start = state.currentTime;
      emit('audio');
      renderTrackList();
    });

    controls.append(volWrap, duckWrap, startBtn);
    row.append(head, controls);
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
