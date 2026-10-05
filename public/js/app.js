/* ==========================================================================
   WhisperSub Web — application controller.
   The browser counterpart of Sources/WhisperSub/AppViewModel.swift +
   ContentView.swift: video loading, Start/End clipping, transcription,
   .SRT import/export, and subtitle burning.
   ========================================================================== */

import * as SRT from './srt.js';
import { MODELS, DEFAULT_MODEL_ID, getModel, formatMB, findCachedModels, detectBackend, LANGUAGES, languageName } from './models.js';
import { inspectVideo, clipVideo, extractAudio16k, burnSubtitles, ConversionCanceledError, hasWebCodecs } from './media.js';

/* ------------------------------------------------------------------------
   DOM
   ------------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const els = {
  engineBadge: $('engine-badge'),
  engineBadgeText: $('engine-badge-text'),
  modelSelect: $('model-select'),
  languageSelect: $('language-select'),
  stage: $('stage'),
  dropzone: $('dropzone'),
  dropVeil: $('drop-veil'),
  player: $('player'),
  video: $('video'),
  fallback: $('player-fallback'),
  fallbackName: $('fallback-name'),
  fallbackMeta: $('fallback-meta'),
  liveCaption: $('live-caption'),
  metaBar: $('meta-bar'),
  metaName: $('meta-name'),
  metaDetails: $('meta-details'),
  btnChangeVideo: $('btn-change-video'),
  clipTitle: $('clip-title'),
  clipStart: $('clip-start'),
  clipEnd: $('clip-end'),
  btnStartPlayhead: $('btn-start-playhead'),
  btnEndPlayhead: $('btn-end-playhead'),
  clipChip: $('clip-chip'),
  btnClip: $('btn-clip'),
  btnResetClip: $('btn-reset-clip'),
  btnTranscribe: $('btn-transcribe'),
  btnTranscribeLabel: $('btn-transcribe-label'),
  btnSaveSrt: $('btn-save-srt'),
  btnBurn: $('btn-burn'),
  statusIcon: $('status-icon'),
  statusMessage: $('status-message'),
  statusLinks: $('status-links'),
  btnCancel: $('btn-cancel'),
  progressBlock: $('progress-block'),
  progressLabel: $('progress-label'),
  progressValue: $('progress-value'),
  progressTrack: $('progress-track'),
  progressFill: $('progress-fill'),
  statusDetail: $('status-detail'),
  statusError: $('status-error'),
  statusErrorText: $('status-error-text'),
  tabCues: $('tab-cues'),
  tabRaw: $('tab-raw'),
  btnLoadSrt: $('btn-load-srt'),
  btnCopySrt: $('btn-copy-srt'),
  btnCopyLabel: $('btn-copy-label'),
  emptyState: $('empty-state'),
  cueList: $('cue-list'),
  rawWrap: $('raw-wrap'),
  rawSrt: $('raw-srt'),
  rawHint: $('raw-hint'),
  fileVideo: $('file-video'),
  fileSrt: $('file-srt'),
  toast: $('toast'),
};

/* ------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------ */

const storedModel = localStorage.getItem('whispersub.model');
const storedLanguage = localStorage.getItem('whispersub.language');

const state = {
  backend: { device: 'wasm', profile: 'wasm', label: '', detected: false },
  modelId: MODELS.some((m) => m.id === storedModel) ? storedModel : DEFAULT_MODEL_ID,
  language: LANGUAGES.some(([c]) => c === storedLanguage) ? storedLanguage : 'auto',
  cachedModels: new Set(),

  originalFile: null,
  originalMeta: null,
  workingFile: null,
  workingMeta: null,
  workingURL: null,
  playable: true,

  appliedClip: null,
  clipStartText: '00:00.0',
  clipEndText: '',

  cues: [],
  srtText: '',

  busy: false,
  phase: null, // clipping | extracting | downloading | loading | warming | transcribing | burning
  progress: null, // 0…1, or null for indeterminate
  progressLabel: '',
  detail: '',
  status: 'Drop a video file to begin.',
  error: null,
  abort: null,

  outputs: { clip: null, srt: null, burned: null },
  inspector: 'cues',
  activeCueId: null,
};

/* ------------------------------------------------------------------------
   Small utilities
   ------------------------------------------------------------------------ */

const baseName = (name) => String(name || 'video').replace(/\.[^./\\]+$/, '');
const fmtShort = SRT.formatShortTimestamp;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
}

function setOutput(kind, blob, name) {
  if (state.outputs[kind]?.url) URL.revokeObjectURL(state.outputs[kind].url);
  state.outputs[kind] = blob ? { url: URL.createObjectURL(blob), name, blob } : null;
}

function triggerDownload(url, name) {
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Asks where to save *before* long work starts (like the native NSSavePanel),
 * using the File System Access API when available.
 */
async function pickSaveTarget(suggestedName, description, mime, ext) {
  if (!window.showSaveFilePicker) return { handle: null, name: suggestedName };
  try {
    const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [ext] } }] });
    return { handle, name: handle.name };
  } catch (err) {
    if (err?.name === 'AbortError') return null; // user cancelled
    return { handle: null, name: suggestedName };
  }
}

async function writeToTarget(target, blob) {
  if (target.handle) {
    const writable = await target.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------------
   Clip range logic (port of resolveClipRange / hasUnappliedClipChanges)
   ------------------------------------------------------------------------ */

const sourceDuration = () => state.originalMeta?.duration ?? state.workingMeta?.duration ?? 0;

function resolveClipRange() {
  const startText = state.clipStartText.trim();
  const endText = state.clipEndText.trim();
  const maxDur = sourceDuration();

  let start = 0;
  if (startText) {
    const parsed = SRT.parseFlexibleTimestamp(startText);
    if (parsed === null) throw new Error(`Could not parse start time “${startText}”. Use MM:SS, HH:MM:SS, or seconds.`);
    start = parsed;
  }
  if (maxDur > 0 && start >= maxDur - 0.05) {
    throw new Error(`Start time (${fmtShort(start)}) must be less than the video duration (${fmtShort(maxDur)}).`);
  }

  let end;
  if (!endText) {
    if (!(maxDur > 0)) return null;
    end = maxDur;
  } else {
    const parsed = SRT.parseFlexibleTimestamp(endText);
    if (parsed === null) throw new Error(`Could not parse end time “${endText}”. Use MM:SS, HH:MM:SS, or seconds.`);
    end = maxDur > 0 ? Math.min(parsed, maxDur) : parsed;
  }
  if (!(end > start + 0.05)) {
    throw new Error(`End time (${fmtShort(end)}) must be greater than start time (${fmtShort(start)}).`);
  }

  const customStart = start > 0.05;
  const customEnd = maxDur > 0 ? end < maxDur - 0.15 : !!endText;
  return customStart || customEnd ? { start, end } : null;
}

function tryResolveClip() {
  try {
    return { range: resolveClipRange(), error: null };
  } catch (error) {
    return { range: null, error };
  }
}

const hasCustomClipRange = () => !!tryResolveClip().range;

function hasUnappliedClipChanges() {
  const { range, error } = tryResolveClip();
  if (error) return true;
  if (!range) return !!state.appliedClip;
  const a = state.appliedClip;
  return !a || Math.abs(range.start - a.start) > 0.05 || Math.abs(range.end - a.end) > 0.05;
}

/* ------------------------------------------------------------------------
   Video loading
   ------------------------------------------------------------------------ */

function setWorkingVideo(file, meta) {
  if (state.workingURL && state.workingFile !== state.originalFile) URL.revokeObjectURL(state.workingURL);
  state.workingFile = file;
  state.workingMeta = meta;
  state.workingURL = file === state.originalFile && state.originalURL ? state.originalURL : URL.createObjectURL(file);
  state.playable = true;
  state.activeCueId = null;
  els.video.src = state.workingURL;
  els.video.load();
}

function resetSubtitles() {
  state.cues = [];
  state.srtText = '';
  setOutput('srt', null);
  setOutput('burned', null);
}

async function loadVideo(file, companionSrt = null) {
  if (state.busy) return;

  // Release previous resources.
  for (const kind of ['clip', 'srt', 'burned']) setOutput(kind, null);
  if (state.workingURL) URL.revokeObjectURL(state.workingURL);
  if (state.originalURL && state.originalURL !== state.workingURL) URL.revokeObjectURL(state.originalURL);

  state.error = null;
  state.detail = '';
  state.appliedClip = null;
  state.originalFile = file;
  state.originalMeta = null;
  state.originalURL = URL.createObjectURL(file);
  state.workingURL = null;
  state.clipStartText = '00:00.0';
  state.clipEndText = '';
  resetSubtitles();
  setWorkingVideo(file, null);
  state.status = `Loaded “${file.name}”. Ready to transcribe.`;

  if (companionSrt) {
    try {
      const parsed = SRT.parseSRT(await companionSrt.text());
      if (parsed.length) {
        applyCues(parsed);
        state.status = `Loaded “${file.name}” and ${parsed.length} cues from ${companionSrt.name}.`;
      }
    } catch {
      /* ignore unreadable companion */
    }
  }
  render();

  try {
    const meta = await inspectVideo(file);
    if (state.originalFile !== file) return; // superseded
    state.originalMeta = meta;
    if (!state.appliedClip) {
      state.workingMeta = meta;
      if (!state.clipEndText.trim()) state.clipEndText = fmtShort(meta.duration);
    }
    if (!meta.hasAudio) {
      state.error = 'This video has no audio track, so it can’t be transcribed. You can still load an .SRT and burn it in.';
    } else if (!meta.canDecodeAudio) {
      state.error = `This browser can’t decode the video’s ${meta.audioCodec ?? 'unknown'} audio. Try Chrome or Edge.`;
    }
  } catch (err) {
    if (state.originalFile !== file) return;
    state.error = err?.message ?? String(err);
  }
  render();
}

async function handleFiles(fileList) {
  if (state.busy) return;
  const files = [...fileList];
  const isSrt = (f) => /\.(srt|vtt)$/i.test(f.name);
  const video = files.find((f) => !isSrt(f));
  const srts = files.filter(isSrt);

  if (video) {
    const match = srts.find((s) => baseName(s.name) === baseName(video.name)) ?? srts[0] ?? null;
    await loadVideo(video, match);
  } else if (srts.length) {
    await importSRT(srts[0]);
  }
}

/* ------------------------------------------------------------------------
   Long-running task scaffolding
   ------------------------------------------------------------------------ */

function beginTask() {
  state.busy = true;
  state.error = null;
  state.detail = '';
  state.abort = new AbortController();
  render();
  return state.abort.signal;
}

function endTask() {
  state.busy = false;
  state.phase = null;
  state.progress = null;
  state.abort = null;
  render();
}

function setPhase(phase, progress = null, label = '') {
  state.phase = phase;
  state.progress = progress;
  state.progressLabel = label;
  renderStatus();
}

const isCancel = (err) => err instanceof ConversionCanceledError || err?.name === 'AbortError' || /cancel/i.test(err?.message ?? '');

/* ------------------------------------------------------------------------
   Clipping (port of performClipIfNeeded)
   ------------------------------------------------------------------------ */

function revertToOriginal() {
  state.appliedClip = null;
  setOutput('clip', null);
  resetSubtitles();
  setWorkingVideo(state.originalFile, state.originalMeta);
}

async function performClipIfNeeded({ force = false, signal } = {}) {
  const range = resolveClipRange();
  if (!range) {
    if (state.appliedClip) revertToOriginal();
    return;
  }
  const a = state.appliedClip;
  if (!force && a && Math.abs(range.start - a.start) <= 0.05 && Math.abs(range.end - a.end) <= 0.05) return;

  state.status = `Clipping video from ${fmtShort(range.start)} to ${fmtShort(range.end)}…`;
  setPhase('clipping', 0, 'Clipping video to selected time range…');

  const blob = await clipVideo(state.originalFile, range.start, range.end, {
    signal,
    onProgress: (p) => setPhase('clipping', p, 'Clipping video to selected time range…'),
  });
  const base = baseName(state.originalFile.name);
  const name = base.endsWith('_clipped') ? `${base}_trim.mp4` : `${base}_clipped.mp4`;
  const file = new File([blob], name, { type: 'video/mp4' });
  const meta = await inspectVideo(file);

  state.appliedClip = range;
  setOutput('clip', blob, name);
  resetSubtitles();
  setWorkingVideo(file, meta);
}

async function clipNow() {
  if (!state.originalFile || state.busy) return;
  const signal = beginTask();
  try {
    await performClipIfNeeded({ force: true, signal });
    const r = state.appliedClip;
    state.status = r
      ? `Clipped video to ${fmtShort(r.start)} – ${fmtShort(r.end)} (${fmtShort(state.workingMeta?.duration ?? r.end - r.start)}).`
      : `Full video range active (“${state.originalFile.name}”).`;
  } catch (err) {
    state.status = isCancel(err) ? 'Clipping cancelled.' : 'Failed to clip video.';
    if (!isCancel(err)) state.error = err?.message ?? String(err);
  } finally {
    endTask();
  }
}

function resetClip() {
  if (!state.originalFile || state.busy) return;
  state.error = null;
  state.clipStartText = '00:00.0';
  state.clipEndText = state.originalMeta ? fmtShort(state.originalMeta.duration) : '';
  if (state.appliedClip) {
    revertToOriginal();
  }
  state.status = `Reset to full video “${state.originalFile.name}”.`;
  render();
}

function setClipToPlayhead(which) {
  const t = Math.max(0, (state.appliedClip?.start ?? 0) + (els.video.currentTime || 0));
  if (which === 'start') state.clipStartText = fmtShort(t);
  else state.clipEndText = fmtShort(t);
  render();
}

/* ------------------------------------------------------------------------
   Whisper worker
   ------------------------------------------------------------------------ */

let worker = null;
const getWorker = () => (worker ??= new Worker(new URL('./whisper.worker.js', import.meta.url), { type: 'module' }));

function killWorker() {
  worker?.terminate();
  worker = null;
}

function runWhisper(audio, { signal, onMessage }) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const cleanup = () => {
      w.removeEventListener('message', onWorkerMessage);
      w.removeEventListener('error', onWorkerError);
      signal?.removeEventListener('abort', onAbort);
    };
    let heardFromWorker = false;
    const onWorkerMessage = ({ data }) => {
      heardFromWorker = true;
      if (data.type === 'done') {
        cleanup();
        resolve(data);
      } else if (data.type === 'error') {
        cleanup();
        reject(new Error(data.message));
      } else {
        onMessage(data);
      }
    };
    const onWorkerError = (e) => {
      cleanup();
      killWorker();
      const fallback = heardFromWorker
        ? 'The Whisper worker crashed (possibly out of GPU memory). Try a smaller model.'
        : 'The Whisper engine failed to start. Check your network connection (the model runtime loads from cdn.jsdelivr.net).';
      reject(new Error(e.message || fallback));
    };
    const onAbort = () => {
      cleanup();
      killWorker(); // immediate stop; weights stay in the browser cache
      reject(new DOMException('Transcription cancelled.', 'AbortError'));
    };
    w.addEventListener('message', onWorkerMessage);
    w.addEventListener('error', onWorkerError);
    signal?.addEventListener('abort', onAbort, { once: true });

    const { device, profile } = state.backend;
    w.postMessage(
      { type: 'transcribe', audio, modelId: state.modelId, device, profile, language: state.language, task: 'transcribe' },
      [audio.buffer],
    );
  });
}

/* ------------------------------------------------------------------------
   Transcription
   ------------------------------------------------------------------------ */

const backendName = () => (state.backend.device === 'webgpu' ? 'WebGPU' : 'CPU (WASM)');

async function transcribe() {
  if (!state.workingFile || state.busy) return;
  const signal = beginTask();
  const model = getModel(state.modelId);
  setOutput('srt', null);
  setOutput('burned', null);

  try {
    await performClipIfNeeded({ signal });

    state.status = `Extracting audio for ${model.name}…`;
    setPhase('extracting', 0, 'Extracting 16 kHz PCM audio track from video…');
    const audio = await extractAudio16k(state.workingFile, {
      signal,
      onProgress: (p) => setPhase('extracting', p, 'Extracting 16 kHz PCM audio track from video…'),
    });

    state.status = `Preparing ${model.name} on ${backendName()}…`;
    setPhase('loading', null, `Loading ${model.name}…`);

    const liveSegments = [];
    let detectedName = state.language !== 'auto' ? languageName(state.language) : null;

    const result = await runWhisper(audio, {
      signal,
      onMessage: (msg) => {
        switch (msg.type) {
          case 'status':
            if (msg.state === 'downloading') {
              const extra = msg.total ? ` (${formatBytes(msg.loaded)} of ${formatBytes(msg.total)})` : '';
              state.status = `Downloading ${msg.model} weights — first run only, cached afterwards.`;
              setPhase('downloading', msg.progress, `Downloading ${msg.model}${extra}…`);
            } else if (msg.state === 'loading') {
              state.status = `Preparing ${msg.model} on ${backendName()}…`;
              setPhase('loading', null, `Compiling ${msg.model} for ${backendName()}…`);
            } else if (msg.state === 'warming') {
              setPhase('warming', null, `Warming up ${backendName()} kernels…`);
            }
            break;
          case 'backend':
            state.backend = { ...state.backend, device: msg.device, profile: msg.profile, label: '' };
            toast('WebGPU unavailable for this model — falling back to CPU.');
            renderHeader();
            break;
          case 'language':
            detectedName = msg.name;
            break;
          case 'live':
            state.detail = msg.text;
            if (state.phase !== 'transcribing') {
              state.status = `Transcribing with ${model.name}…`;
              setPhase('transcribing', 0, 'Transcribing…');
            }
            renderStatus();
            break;
          case 'progress': {
            liveSegments.push(...msg.segments);
            applyCues(SRT.buildSubtitleCues(liveSegments), { fresh: true });
            const lang = detectedName ? ` (${detectedName})` : '';
            setPhase('transcribing', msg.value, `Transcribing${lang} — window ${msg.window} of ${msg.windows}`);
            renderInspector();
            renderActions();
            break;
          }
        }
      },
    });

    const cues = SRT.buildSubtitleCues(result.segments);
    applyCues(cues);
    const langLabel = result.language ? ` · ${languageName(result.language)}` : '';
    if (cues.length) {
      const name = `${baseName(state.workingFile.name)}.srt`;
      setOutput('srt', new Blob([state.srtText], { type: 'application/x-subrip' }), name);
      state.status = `Transcribed ${cues.length} subtitle segments${langLabel}.`;
    } else {
      state.status = 'Transcription finished, but no speech was detected.';
    }
    if (result.elapsed > 0) {
      const speed = result.audioDuration / result.elapsed;
      state.detail = `${result.device === 'webgpu' ? 'WebGPU' : 'CPU'} decoded ${fmtShort(result.audioDuration)} of audio in ${result.elapsed.toFixed(1)} s — ${speed.toFixed(1)}× real-time.`;
    } else {
      state.detail = '';
    }
    refreshCachedModels();
  } catch (err) {
    if (isCancel(err)) {
      state.status = 'Transcription cancelled.';
    } else {
      state.status = 'Transcription failed.';
      state.error = err?.message ?? String(err);
    }
    state.detail = '';
  } finally {
    endTask();
  }
}

/* ------------------------------------------------------------------------
   Subtitles: apply / import / export
   ------------------------------------------------------------------------ */

function applyCues(cues, { fresh = false } = {}) {
  const previousCount = state.cues.length;
  state.cues = SRT.renumber(cues);
  state.srtText = SRT.formatSRT(state.cues);
  state.freshFrom = fresh ? previousCount : Infinity;
  cuesDirty = true;
}

async function importSRT(file) {
  if (state.busy) return;
  try {
    const parsed = SRT.parseSRT(await file.text());
    if (!parsed.length) throw new Error(`No subtitle cues found in ${file.name}.`);
    applyCues(parsed);
    setOutput('srt', file, file.name);
    setOutput('burned', null);
    state.error = null;
    state.status = `Loaded ${parsed.length} subtitle cues from ${file.name}.`;
  } catch (err) {
    state.error = `Failed to read .srt file: ${err?.message ?? err}`;
  }
  render();
}

async function saveSRT() {
  if (!state.cues.length || state.busy) return;
  const name = `${baseName(state.workingFile?.name ?? 'subtitles')}.srt`;
  const blob = new Blob([SRT.formatSRT(state.cues)], { type: 'application/x-subrip' });
  const target = await pickSaveTarget(name, 'SubRip subtitles', 'application/x-subrip', '.srt');
  if (!target) return;
  try {
    setOutput('srt', blob, target.name);
    if (!(await writeToTarget(target, blob))) triggerDownload(state.outputs.srt.url, target.name);
    state.status = `Saved subtitles to ${target.name}.`;
  } catch (err) {
    state.error = `Could not save .srt file: ${err?.message ?? err}`;
  }
  render();
}

async function copySRT() {
  if (!state.srtText) return;
  try {
    await navigator.clipboard.writeText(state.srtText);
    state.status = `Copied .SRT content (${state.cues.length} cues) to clipboard.`;
    els.btnCopyLabel.textContent = 'Copied!';
    setTimeout(() => (els.btnCopyLabel.textContent = 'Copy .SRT'), 1400);
  } catch {
    state.error = 'Clipboard access was blocked by the browser.';
  }
  render();
}

/* ------------------------------------------------------------------------
   Burn subtitles into video
   ------------------------------------------------------------------------ */

async function burn() {
  if (!state.workingFile || !state.cues.length || state.busy) return;
  const suggested = `${baseName(state.workingFile.name)}_subtitled.mp4`;
  const target = await pickSaveTarget(suggested, 'MP4 video', 'video/mp4', '.mp4');
  if (!target) return;

  const signal = beginTask();
  const cues = state.cues.map((c) => ({ ...c }));
  state.status = `Burning ${cues.length} subtitles into video…`;
  setPhase('burning', 0, 'Rendering & encoding burned-in subtitles…');
  const t0 = performance.now();

  try {
    const { blob, videoCodec } = await burnSubtitles(state.workingFile, cues, {
      signal,
      onProgress: (p) => setPhase('burning', p, 'Rendering & encoding burned-in subtitles…'),
    });
    setOutput('burned', blob, target.name);
    if (!(await writeToTarget(target, blob))) triggerDownload(state.outputs.burned.url, target.name);

    const secs = (performance.now() - t0) / 1000;
    state.status = `Burned subtitles into ${target.name}!`;
    state.detail = `Encoded ${formatBytes(blob.size)} with ${videoCodec.toUpperCase()} in ${secs.toFixed(1)} s.`;

    // If the source can't be previewed natively, switch the player to the playable MP4.
    if (!state.playable) {
      els.video.src = state.outputs.burned.url;
      els.video.load();
      state.playable = true;
    }
  } catch (err) {
    if (isCancel(err)) {
      state.status = 'Burning cancelled.';
    } else {
      state.status = 'Failed to burn subtitles.';
      state.error = err?.message ?? String(err);
    }
  } finally {
    endTask();
  }
}

/* ------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------ */

let cuesDirty = true;

function renderHeader() {
  const { device, label, detected } = state.backend;
  els.engineBadge.classList.toggle('gpu', detected && device === 'webgpu');
  els.engineBadge.classList.toggle('cpu', detected && device !== 'webgpu');
  els.engineBadgeText.textContent = !detected ? 'Detecting GPU…' : device === 'webgpu' ? 'WebGPU' : 'CPU · WASM';
  els.engineBadge.title = !detected
    ? 'Detecting inference backend…'
    : device === 'webgpu'
      ? `Whisper runs on your GPU via WebGPU${label ? ` (${label})` : ''}. Nothing is uploaded.`
      : 'WebGPU is unavailable in this browser, so Whisper runs on the CPU (slower). Try Chrome or Edge for GPU acceleration.';

  const profile = state.backend.profile;
  els.modelSelect.innerHTML = MODELS.map((m) => {
    const cached = state.cachedModels.has(m.id) ? ' ✓' : '';
    return `<option value="${m.id}">${m.name} (${formatMB(m.sizesMB[profile])} • ${m.badge})${cached}</option>`;
  }).join('');
  els.modelSelect.value = state.modelId;
  els.modelSelect.disabled = state.busy;
  els.languageSelect.disabled = state.busy;
}

function renderWorkspace() {
  const hasVideo = !!state.workingFile;
  els.dropzone.hidden = hasVideo;
  els.player.hidden = !hasVideo;
  els.metaBar.hidden = !hasVideo;
  els.dropzone.disabled = state.busy;

  if (hasVideo) {
    const meta = state.workingMeta;
    els.metaName.textContent = state.workingFile.name;
    els.metaName.title = state.workingFile.name;
    els.metaDetails.textContent = meta
      ? `${Math.round(meta.width)}×${Math.round(meta.height)} · ${fmtShort(meta.duration)} · ${Math.round(meta.frameRate)} fps · ${formatBytes(meta.fileSize)}`
      : 'Reading metadata…';
    els.fallback.hidden = state.playable;
    els.fallbackName.textContent = state.workingFile.name;
    els.fallbackMeta.textContent = els.metaDetails.textContent;
  }
  els.btnChangeVideo.disabled = state.busy;
}

function renderClipBar() {
  const hasVideo = !!state.workingFile;
  const { range, error } = tryResolveClip();
  const unapplied = hasUnappliedClipChanges();

  if (document.activeElement !== els.clipStart) els.clipStart.value = state.clipStartText;
  if (document.activeElement !== els.clipEnd) els.clipEnd.value = state.clipEndText;
  els.clipEnd.placeholder = state.originalMeta ? fmtShort(state.originalMeta.duration) : 'End';

  const startBad = error && /start/i.test(error.message);
  const endBad = error && !startBad;
  els.clipStart.classList.toggle('invalid', !!(hasVideo && startBad));
  els.clipEnd.classList.toggle('invalid', !!(hasVideo && endBad));
  els.clipStart.title = startBad ? error.message : '';
  els.clipEnd.title = endBad ? error.message : '';

  for (const el of [els.clipStart, els.clipEnd, els.btnStartPlayhead, els.btnEndPlayhead]) el.disabled = !hasVideo || state.busy;
  els.clipTitle.classList.toggle('active', !!state.appliedClip || !!range);

  const a = state.appliedClip;
  els.clipChip.hidden = !(a && !unapplied);
  if (a) els.clipChip.textContent = `Clipped (${fmtShort(a.end - a.start)})`;

  els.btnClip.disabled = !hasVideo || state.busy || !unapplied || !!error;
  els.btnResetClip.hidden = !(state.appliedClip || range);
  els.btnResetClip.disabled = state.busy;
}

function renderActions() {
  const hasVideo = !!state.workingFile;
  const hasCues = state.cues.length > 0;
  const noAudio = state.originalMeta && !state.originalMeta.hasAudio;
  els.btnTranscribe.disabled = !hasVideo || state.busy || !!noAudio;
  els.btnTranscribeLabel.textContent = hasUnappliedClipChanges() && hasCustomClipRange() ? '1. Clip & Transcribe' : '1. Transcribe Video';
  els.btnSaveSrt.disabled = !hasCues || state.busy;
  els.btnBurn.disabled = !hasVideo || !hasCues || state.busy;
  els.btnLoadSrt.disabled = state.busy;
  els.btnCopySrt.disabled = !hasCues;
}

const ICONS = {
  info: '<svg class="ico"><use href="#i-info"/></svg>',
  ok: '<svg class="ico"><use href="#i-check"/></svg>',
  err: '<svg class="ico"><use href="#i-error"/></svg>',
  busy: '<span class="spinner" aria-hidden="true"></span>',
};

function renderStatus() {
  const kind = state.busy ? 'busy' : state.error ? 'err' : state.cues.length ? 'ok' : 'info';
  if (els.statusIcon.dataset.kind !== kind) {
    els.statusIcon.innerHTML = ICONS[kind];
    els.statusIcon.dataset.kind = kind;
    els.statusIcon.className = `status-icon ${kind}`;
  }
  els.statusMessage.textContent = state.status;

  // Progress
  const showProgress = state.busy && state.phase;
  els.progressBlock.hidden = !showProgress;
  if (showProgress) {
    const determinate = typeof state.progress === 'number';
    els.progressLabel.textContent = state.progressLabel;
    els.progressValue.textContent = determinate ? `${Math.round(state.progress * 100)}%` : '';
    els.progressTrack.classList.toggle('indeterminate', !determinate);
    els.progressTrack.classList.toggle('burn', state.phase === 'burning');
    els.progressFill.style.width = determinate ? `${(state.progress * 100).toFixed(1)}%` : '';
  }
  els.btnCancel.hidden = !state.busy;

  // Detail line (live transcript / speed)
  els.statusDetail.hidden = !state.detail;
  if (state.detail) {
    const bdi = document.createElement('bdi');
    bdi.textContent = state.detail;
    els.statusDetail.replaceChildren(bdi);
  }

  // Error
  els.statusError.hidden = !state.error;
  els.statusErrorText.textContent = state.error ?? '';

  // Download links (replace “Reveal in Finder”)
  const links = [
    ['clip', 'Clip', '#i-scissors'],
    ['srt', '.SRT', '#i-doc-up'],
    ['burned', 'Burned Video', '#i-flame'],
  ].filter(([k]) => state.outputs[k] && !state.busy);
  const signature = links.map(([k]) => `${k}:${state.outputs[k].url}`).join('|');
  if (els.statusLinks.dataset.sig !== signature) {
    els.statusLinks.dataset.sig = signature;
    els.statusLinks.innerHTML = '';
    for (const [k, label, icon] of links) {
      const a = document.createElement('a');
      a.className = 'btn btn-sm';
      a.href = state.outputs[k].url;
      a.download = state.outputs[k].name;
      a.title = `Download ${state.outputs[k].name}`;
      a.innerHTML = `<svg class="ico ico-sm"><use href="${icon}"/></svg>`;
      a.append(label);
      els.statusLinks.appendChild(a);
    }
  }
}

function renderInspector() {
  const hasCues = state.cues.length > 0;
  els.tabCues.classList.toggle('active', state.inspector === 'cues');
  els.tabRaw.classList.toggle('active', state.inspector === 'raw');
  els.tabCues.setAttribute('aria-selected', String(state.inspector === 'cues'));
  els.tabRaw.setAttribute('aria-selected', String(state.inspector === 'raw'));

  els.emptyState.hidden = hasCues;
  els.cueList.hidden = !hasCues || state.inspector !== 'cues';
  els.rawWrap.hidden = !hasCues || state.inspector !== 'raw';

  if (cuesDirty) {
    cuesDirty = false;
    const frag = document.createDocumentFragment();
    state.cues.forEach((cue, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cue${i >= (state.freshFrom ?? Infinity) ? ' fresh' : ''}`;
      btn.dataset.id = cue.id;
      btn.dataset.start = cue.startTime;
      btn.innerHTML = `<span class="cue-num">#${cue.id}</span><span><div class="cue-time"></div><div class="cue-text"></div></span>`;
      btn.querySelector('.cue-time').textContent = `${SRT.formatTimestamp(cue.startTime)} → ${SRT.formatTimestamp(cue.endTime)}`;
      btn.querySelector('.cue-text').textContent = cue.text;
      li.appendChild(btn);
      frag.appendChild(li);
    });
    els.cueList.replaceChildren(frag);
    if (state.freshFrom < state.cues.length && state.busy) {
      els.cueList.scrollTop = els.cueList.scrollHeight;
    }
    state.activeCueId = null;
    if (document.activeElement !== els.rawSrt) els.rawSrt.value = state.srtText;
    els.rawHint.textContent = 'Edits are applied when you click away.';
    els.rawHint.classList.remove('err');
    updateActiveCue();
  }
  els.rawSrt.readOnly = state.busy;
}

function updateActiveCue() {
  if (!state.workingFile) return;
  const cue = state.cues.length ? SRT.findActiveCue(state.cues, els.video.currentTime || 0) : null;
  const id = cue?.id ?? null;

  if (cue) {
    if (els.liveCaption.textContent !== cue.text || els.liveCaption.hidden) {
      els.liveCaption.textContent = cue.text;
      els.liveCaption.hidden = false;
    }
  } else if (!els.liveCaption.hidden) {
    els.liveCaption.hidden = true;
  }

  if (id === state.activeCueId) return;
  els.cueList.querySelector('.cue.active')?.classList.remove('active');
  state.activeCueId = id;
  if (id !== null) {
    const el = els.cueList.querySelector(`.cue[data-id="${id}"]`);
    if (el) {
      el.classList.add('active');
      if (!els.video.paused && !state.busy) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

function render() {
  renderHeader();
  renderWorkspace();
  renderClipBar();
  renderActions();
  renderStatus();
  renderInspector();
}

/* ------------------------------------------------------------------------
   Events
   ------------------------------------------------------------------------ */

function openVideoPicker() {
  if (state.busy) return;
  els.fileVideo.value = '';
  els.fileVideo.click();
}

els.dropzone.addEventListener('click', openVideoPicker);
els.btnChangeVideo.addEventListener('click', openVideoPicker);
els.fileVideo.addEventListener('change', () => els.fileVideo.files.length && handleFiles(els.fileVideo.files));

els.btnLoadSrt.addEventListener('click', () => {
  els.fileSrt.value = '';
  els.fileSrt.click();
});
els.fileSrt.addEventListener('change', () => els.fileSrt.files[0] && importSRT(els.fileSrt.files[0]));

// Window-wide drag & drop.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || state.busy) return;
  e.preventDefault();
  dragDepth++;
  els.dropVeil.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropVeil.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropVeil.hidden = true;
  if (!state.busy && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

els.modelSelect.addEventListener('change', () => {
  state.modelId = els.modelSelect.value;
  localStorage.setItem('whispersub.model', state.modelId);
});
els.languageSelect.addEventListener('change', () => {
  state.language = els.languageSelect.value;
  localStorage.setItem('whispersub.language', state.language);
});

els.clipStart.addEventListener('input', () => {
  state.clipStartText = els.clipStart.value;
  renderClipBar();
  renderActions();
});
els.clipEnd.addEventListener('input', () => {
  state.clipEndText = els.clipEnd.value;
  renderClipBar();
  renderActions();
});
for (const input of [els.clipStart, els.clipEnd]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !els.btnClip.disabled) clipNow();
  });
}
els.btnStartPlayhead.addEventListener('click', () => setClipToPlayhead('start'));
els.btnEndPlayhead.addEventListener('click', () => setClipToPlayhead('end'));
els.btnClip.addEventListener('click', clipNow);
els.btnResetClip.addEventListener('click', resetClip);

els.btnTranscribe.addEventListener('click', transcribe);
els.btnSaveSrt.addEventListener('click', saveSRT);
els.btnBurn.addEventListener('click', burn);
els.btnCancel.addEventListener('click', () => state.abort?.abort());
els.btnCopySrt.addEventListener('click', copySRT);

els.tabCues.addEventListener('click', () => {
  state.inspector = 'cues';
  renderInspector();
  updateActiveCue();
});
els.tabRaw.addEventListener('click', () => {
  state.inspector = 'raw';
  renderInspector();
});

els.cueList.addEventListener('click', (e) => {
  const btn = e.target.closest('.cue');
  if (!btn || !state.workingFile) return;
  els.video.currentTime = Number(btn.dataset.start) + 0.001;
  updateActiveCue();
});

// Raw .SRT editing — parse and apply on blur.
els.rawSrt.addEventListener('change', () => {
  const text = els.rawSrt.value;
  const parsed = SRT.parseSRT(text);
  if (!parsed.length && text.trim()) {
    els.rawHint.textContent = 'Couldn’t parse any cues — check the timestamps (HH:MM:SS,mmm --> HH:MM:SS,mmm).';
    els.rawHint.classList.add('err');
    return;
  }
  applyCues(parsed);
  setOutput('burned', null);
  if (state.outputs.srt) setOutput('srt', new Blob([state.srtText], { type: 'application/x-subrip' }), state.outputs.srt.name);
  state.status = `Applied edits — ${parsed.length} cues.`;
  render();
});

// Playback-synchronized captions (rAF while playing, events otherwise).
let rafId = 0;
const tick = () => {
  updateActiveCue();
  rafId = els.video.paused ? 0 : requestAnimationFrame(tick);
};
els.video.addEventListener('play', () => {
  if (!rafId) rafId = requestAnimationFrame(tick);
});
for (const ev of ['seeked', 'timeupdate', 'loadeddata']) els.video.addEventListener(ev, updateActiveCue);
els.video.addEventListener('loadeddata', () => {
  if (!state.playable) {
    state.playable = true;
    renderWorkspace();
  }
});
els.video.addEventListener('error', () => {
  if (!state.workingFile) return;
  state.playable = false;
  renderWorkspace();
});

window.addEventListener('beforeunload', (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------ */

async function refreshCachedModels() {
  state.cachedModels = await findCachedModels(state.backend.profile);
  renderHeader();
}

async function boot() {
  els.languageSelect.innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  els.languageSelect.value = state.language;
  render();

  if (!hasWebCodecs()) {
    state.error = 'This browser doesn’t support WebCodecs, which WhisperSub needs to read and encode video. Please use a recent Chrome, Edge, or Safari 17+.';
    render();
  }

  const backend = await detectBackend();
  state.backend = { ...backend, detected: true };
  render();
  await refreshCachedModels();
}

boot();
