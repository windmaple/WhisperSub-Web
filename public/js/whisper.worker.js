/* ==========================================================================
   Whisper inference worker — the browser counterpart of
   Sources/WhisperSub/WhisperTranscriptionService.swift.

   Runs OpenAI Whisper (ONNX) through Transformers.js on WebGPU, falling back to
   WASM. Audio is split at low-energy points into ≤30 s windows (similar in
   spirit to WhisperKit's `.vad` chunking strategy), language is auto-detected
   from the first voiced window, and segments stream back with live text.
   ========================================================================== */

// NOTE: `transformers.min.js` is the fully self-contained browser bundle. The
// `transformers.web*.js` builds keep bare `onnxruntime-web` imports and need a bundler.
import {
  pipeline,
  env,
  Tensor,
  WhisperTextStreamer,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';
import { getModel, languageName } from './models.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

const SAMPLE_RATE = 16000;
const MAX_WINDOW_S = 30;

let transcriber = null;
let loadedKey = null;
let cancelRequested = false;

const post = (msg) => self.postMessage(msg);

/* ------------------------------------------------------------------------
   Model loading
   ------------------------------------------------------------------------ */

async function loadModel(modelId, device, profile) {
  const model = getModel(modelId);
  const key = `${model.id}|${profile}`;
  if (transcriber && loadedKey === key) return { device, profile };

  if (transcriber) {
    await transcriber.dispose?.();
    transcriber = null;
    loadedKey = null;
  }

  let sawDownload = false;
  const progress_callback = (info) => {
    if (info.status === 'progress_total') {
      // Only report a download if bytes are actually coming over the network.
      if (info.progress < 100) sawDownload = true;
      if (sawDownload) {
        post({ type: 'status', state: 'downloading', model: model.name, progress: info.progress / 100, loaded: info.loaded, total: info.total });
      }
    } else if (info.status === 'done' || info.status === 'ready') {
      post({ type: 'status', state: 'loading', model: model.name, device });
    }
  };

  post({ type: 'status', state: 'loading', model: model.name, device });
  try {
    transcriber = await pipeline('automatic-speech-recognition', model.repo, {
      device,
      dtype: model.dtypes[profile],
      progress_callback,
    });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // WebGPU can fail on some drivers; retry on the CPU (WASM) backend.
    post({ type: 'backend', device: 'wasm', profile: 'wasm', reason: String(err?.message ?? err) });
    return loadModel(modelId, 'wasm', 'wasm');
  }

  // Warm up shaders so the first real window isn't penalized.
  post({ type: 'status', state: 'warming', model: model.name, device });
  await transcriber(new Float32Array(SAMPLE_RATE), { language: 'en' }).catch(() => {});

  loadedKey = key;
  return { device, profile };
}

/* ------------------------------------------------------------------------
   Energy-based windowing ("poor man's VAD")
   ------------------------------------------------------------------------ */

function planWindows(audio) {
  const frame = 320; // 20 ms
  const nFrames = Math.ceil(audio.length / frame);
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const a = f * frame;
    const b = Math.min(audio.length, a + frame);
    for (let i = a; i < b; i++) sum += audio[i] * audio[i];
    rms[f] = Math.sqrt(sum / Math.max(1, b - a));
  }
  // 100 ms smoothing so we cut inside pauses, not between syllables.
  const smooth = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(nFrames - 1, f + 2); k++, n++) s += rms[k];
    smooth[f] = s / n;
  }

  const windows = [];
  const maxLen = MAX_WINDOW_S * SAMPLE_RATE;
  let start = 0;
  while (start < audio.length) {
    let end;
    if (audio.length - start <= maxLen) {
      end = audio.length;
    } else {
      const lo = Math.floor((start + 12 * SAMPLE_RATE) / frame);
      const hi = Math.floor((start + (MAX_WINDOW_S - 0.5) * SAMPLE_RATE) / frame);
      let best = hi;
      for (let f = hi; f >= lo; f--) if (smooth[f] < smooth[best]) best = f;
      end = Math.min(audio.length, best * frame + frame / 2);
    }
    let peak = 0;
    for (let f = Math.floor(start / frame); f < Math.ceil(end / frame); f++) peak = Math.max(peak, rms[f]);
    // Skip near-digital-silence windows: Whisper tends to hallucinate on them.
    if (end - start > SAMPLE_RATE * 0.3 && peak > 0.0025) windows.push({ start, end });
    start = end;
  }
  return windows;
}

/* ------------------------------------------------------------------------
   Language detection — one decoder step after <|startoftranscript|>,
   restricted to the language tokens.
   ------------------------------------------------------------------------ */

async function detectLanguage(audio) {
  const { model, processor } = transcriber;
  const config = model.generation_config;
  const langToId = config?.lang_to_id;
  if (!langToId || !config.is_multilingual) return null;

  const { input_features } = await processor(audio);
  const sot = BigInt(config.decoder_start_token_id);
  const decoder_input_ids = new Tensor('int64', BigInt64Array.from([sot]), [1, 1]);
  const output = await model({ input_features, decoder_input_ids });

  let logits = output.logits;
  if (logits.type !== 'float32') logits = logits.to('float32');
  const vocab = logits.dims.at(-1);
  const data = logits.data;
  const offset = data.length - vocab;

  let bestToken = null;
  let bestScore = -Infinity;
  for (const [token, id] of Object.entries(langToId)) {
    const score = data[offset + id];
    if (score > bestScore) {
      bestScore = score;
      bestToken = token;
    }
  }
  return bestToken ? bestToken.replace(/^<\|/, '').replace(/\|>$/, '') : null;
}

/* ------------------------------------------------------------------------
   Transcription
   ------------------------------------------------------------------------ */

async function transcribe({ audio, modelId, device, profile, language, task }) {
  cancelRequested = false;
  const backend = await loadModel(modelId, device, profile);

  const audioDuration = audio.length / SAMPLE_RATE;
  const windows = planWindows(audio);
  if (!windows.length) {
    post({ type: 'done', segments: [], language: null, audioDuration, elapsed: 0, device: backend.device });
    return;
  }

  const t0 = performance.now();
  let lang = language && language !== 'auto' ? language : null;
  if (!lang) {
    post({ type: 'live', text: 'Detecting spoken language…' });
    try {
      const first = windows[0];
      lang = (await detectLanguage(audio.subarray(first.start, first.end))) ?? 'en';
    } catch (err) {
      console.warn('[WhisperSub] Language detection failed, defaulting to English.', err);
      lang = 'en';
    }
    post({ type: 'language', code: lang, name: languageName(lang) });
  }
  post({ type: 'live', text: `Listening and decoding (${languageName(lang)})…` });

  const segments = [];
  const processedTotal = windows.reduce((acc, w) => acc + (w.end - w.start), 0);
  let processed = 0;

  for (let i = 0; i < windows.length; i++) {
    if (cancelRequested) throw new Error('Transcription cancelled.');
    const win = windows[i];
    const chunk = audio.subarray(win.start, win.end);
    const offset = win.start / SAMPLE_RATE;
    const windowDuration = chunk.length / SAMPLE_RATE;

    let live = '';
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
      skip_prompt: true,
      callback_function: (text) => {
        live += text;
        const cleaned = live.replace(/\s+/g, ' ').trim();
        if (cleaned) post({ type: 'live', text: cleaned });
      },
    });

    const result = await transcriber(chunk, {
      return_timestamps: true,
      language: lang,
      task: task ?? 'transcribe',
      streamer,
    });

    const windowSegments = [];
    for (const c of result.chunks ?? []) {
      const [s, e] = c.timestamp ?? [0, windowDuration];
      const start = offset + Math.max(0, Math.min(s ?? 0, windowDuration));
      const end = offset + Math.max(0, Math.min(e ?? windowDuration, windowDuration));
      if (c.text?.trim()) windowSegments.push({ start, end: Math.max(end, start + 0.25), text: c.text });
    }
    if (!windowSegments.length && result.text?.trim()) {
      windowSegments.push({ start: offset, end: offset + windowDuration, text: result.text });
    }
    segments.push(...windowSegments);

    processed += win.end - win.start;
    post({ type: 'progress', value: processed / processedTotal, window: i + 1, windows: windows.length, segments: windowSegments });
  }

  const elapsed = (performance.now() - t0) / 1000;
  post({ type: 'done', segments, language: lang, audioDuration, elapsed, device: backend.device });
}

self.addEventListener('message', async ({ data }) => {
  try {
    switch (data.type) {
      case 'load':
        await loadModel(data.modelId, data.device, data.profile);
        post({ type: 'ready' });
        break;
      case 'transcribe':
        await transcribe(data);
        break;
      case 'cancel':
        cancelRequested = true;
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String(err?.message ?? err) });
  }
});
