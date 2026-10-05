/* ==========================================================================
   Whisper model catalog — mirrors `WhisperModelOption.availableModels`.
   Weights are ONNX exports from the Hugging Face `onnx-community` org and are
   cached by the browser (Cache Storage) after the first download.
   ========================================================================== */

export const MODELS = [
  {
    id: 'whisper-tiny',
    repo: 'onnx-community/whisper-tiny',
    name: 'Whisper Tiny',
    badge: 'Fastest',
    dtypes: {
      'webgpu-f16': { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    sizesMB: { 'webgpu-f16': 120, webgpu: 120, wasm: 41 },
  },
  {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    name: 'Whisper Base',
    badge: 'Default',
    dtypes: {
      'webgpu-f16': { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    sizesMB: { 'webgpu-f16': 206, webgpu: 206, wasm: 77 },
  },
  {
    id: 'whisper-small',
    repo: 'onnx-community/whisper-small',
    name: 'Whisper Small',
    badge: 'Accurate',
    dtypes: {
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    sizesMB: { 'webgpu-f16': 410, webgpu: 586, wasm: 249 },
  },
  {
    id: 'whisper-large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    badge: 'Best',
    dtypes: {
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    sizesMB: { 'webgpu-f16': 1608, webgpu: 759, wasm: 1085 },
  },
];

export const DEFAULT_MODEL_ID = 'whisper-base';

export const getModel = (id) => MODELS.find((m) => m.id === id) ?? MODELS[1];

const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q4: '_q4', q8: '_quantized', int8: '_int8', uint8: '_uint8' };

/** The ONNX file names a model needs for a given backend profile. */
export function modelFiles(model, profile) {
  const d = model.dtypes[profile];
  return [`onnx/encoder_model${DTYPE_SUFFIX[d.encoder_model]}.onnx`, `onnx/decoder_model_merged${DTYPE_SUFFIX[d.decoder_model_merged]}.onnx`];
}

export function formatMB(mb) {
  return mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${mb} MB`;
}

/** Returns the set of model ids whose weights are already in the browser cache. */
export async function findCachedModels(profile) {
  const found = new Set();
  if (typeof caches === 'undefined') return found;
  try {
    const cache = await caches.open('transformers-cache');
    const urls = (await cache.keys()).map((r) => r.url);
    for (const model of MODELS) {
      const files = modelFiles(model, profile);
      if (files.every((f) => urls.some((u) => u.includes(`${model.repo}/`) && u.endsWith(f)))) found.add(model.id);
    }
  } catch {
    /* Cache Storage unavailable (e.g. private mode) */
  }
  return found;
}

/** Detects the best inference backend available in this browser. */
export async function detectBackend() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const f16 = adapter.features.has('shader-f16');
        let label = '';
        try {
          const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
          label = [info?.vendor, info?.architecture].filter(Boolean).join(' ');
        } catch {
          /* adapter info is optional */
        }
        return { device: 'webgpu', profile: f16 ? 'webgpu-f16' : 'webgpu', label };
      }
    }
  } catch {
    /* fall through to WASM */
  }
  return { device: 'wasm', profile: 'wasm', label: '' };
}

/** Whisper's supported languages, most common first. */
export const LANGUAGES = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['zh', 'Chinese'],
  ['es', 'Spanish'],
  ['hi', 'Hindi'],
  ['ar', 'Arabic'],
  ['fr', 'French'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['ja', 'Japanese'],
  ['de', 'German'],
  ['ko', 'Korean'],
  ['it', 'Italian'],
  ['tr', 'Turkish'],
  ['vi', 'Vietnamese'],
  ['id', 'Indonesian'],
  ['th', 'Thai'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
  ['sv', 'Swedish'],
  ['he', 'Hebrew'],
  ['el', 'Greek'],
  ['cs', 'Czech'],
  ['ro', 'Romanian'],
  ['hu', 'Hungarian'],
  ['da', 'Danish'],
  ['fi', 'Finnish'],
  ['no', 'Norwegian'],
  ['ms', 'Malay'],
  ['fa', 'Persian'],
  ['ta', 'Tamil'],
  ['bn', 'Bengali'],
  ['ur', 'Urdu'],
  ['yue', 'Cantonese'],
];

export const languageName = (code) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
