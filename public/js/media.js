/* ==========================================================================
   Media pipeline (WebCodecs via Mediabunny) — the browser counterpart of
   Sources/WhisperSub/VideoSubtitleBurner.swift:
     • inspectVideo      → resolution, duration, frame rate, codecs
     • clipVideo         → trim Start/End into a new MP4
     • extractAudio16k   → 16 kHz mono Float32 PCM for Whisper
     • burnSubtitles     → hardware-encoded MP4 with styled captions burned in
   ========================================================================== */

import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/dist/bundles/mediabunny.min.mjs';

import { SubtitleOverlayCache } from './subtitle-renderer.js';

export { ConversionCanceledError };

export class MediaError extends Error {}

const openInput = (file) => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

const DISCARD_REASONS = {
  undecodable_source_codec: 'this browser cannot decode the source codec',
  unknown_source_codec: 'the source codec is unknown',
  no_encodable_target_codec: 'this browser has no suitable encoder',
};

function assertValid(conversion, what) {
  if (conversion.isValid) return;
  const reasons = conversion.discardedTracks
    .map((d) => `${d.track.type} track: ${DISCARD_REASONS[d.reason] ?? d.reason}`)
    .join('; ');
  throw new MediaError(`Cannot ${what}${reasons ? ` (${reasons})` : ''}. Try Chrome, Edge, or Safari 17+.`);
}

function bindAbort(signal, conversion) {
  if (!signal) return () => {};
  const onAbort = () => conversion.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/* ------------------------------------------------------------------------
   Inspect
   ------------------------------------------------------------------------ */

/**
 * Reads container metadata. Works for .mp4 / .mov / .m4v / .webm / .mkv and
 * more, even when the browser's <video> element can't play the file.
 */
export async function inspectVideo(file) {
  const input = openInput(file);
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new MediaError('The selected file does not contain a valid video track.');

    const audioTrack = await input.getPrimaryAudioTrack();
    const [duration, width, height, videoCodec, canDecodeVideo] = await Promise.all([
      input.computeDuration(),
      videoTrack.getDisplayWidth(),
      videoTrack.getDisplayHeight(),
      videoTrack.getCodec(),
      videoTrack.canDecode(),
    ]);

    let frameRate = 30;
    try {
      const stats = await videoTrack.computePacketStats(120);
      if (stats.averagePacketRate > 0) frameRate = stats.averagePacketRate;
    } catch {
      /* keep default */
    }

    return {
      duration,
      width,
      height,
      frameRate,
      fileSize: file.size,
      videoCodec,
      canDecodeVideo,
      hasAudio: !!audioTrack,
      audioCodec: audioTrack ? await audioTrack.getCodec() : null,
      canDecodeAudio: audioTrack ? await audioTrack.canDecode() : false,
    };
  } finally {
    input.dispose();
  }
}

/* ------------------------------------------------------------------------
   Clip
   ------------------------------------------------------------------------ */

/** Trims `file` to [start, end] seconds and returns an MP4 Blob. */
export async function clipVideo(file, start, end, { onProgress, signal } = {}) {
  if (!(end > start + 0.05)) throw new MediaError('End time must be greater than start time.');

  const input = openInput(file);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      trim: { start: Math.max(0, start), end },
      showWarnings: false,
    });
    assertValid(conversion, 'clip this video');
    conversion.onProgress = (p) => onProgress?.(p);

    const unbind = bindAbort(signal, conversion);
    try {
      await conversion.execute();
    } finally {
      unbind();
    }
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}

/* ------------------------------------------------------------------------
   Audio extraction → 16 kHz mono
   ------------------------------------------------------------------------ */

/**
 * Streaming resampler. Uses a box (moving-average) low-pass when downsampling
 * so memory stays O(output) even for hour-long videos.
 */
class StreamingResampler {
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate;
    this.carry = new Float32Array(0);
    this.pos = 0; // fractional read position into (carry + incoming)
    this.chunks = [];
    this.length = 0;
  }

  push(samples) {
    const data = new Float32Array(this.carry.length + samples.length);
    data.set(this.carry, 0);
    data.set(samples, this.carry.length);

    const { ratio } = this;
    const half = Math.max(0.5, ratio / 2);
    const capacity = Math.max(0, Math.floor((data.length - this.pos - half - 1) / ratio) + 1);
    const out = new Float32Array(capacity);
    let n = 0;
    let pos = this.pos;

    while (pos + half + 1 < data.length) {
      if (ratio > 1) {
        const a = Math.max(0, Math.floor(pos - half));
        const b = Math.min(data.length - 1, Math.floor(pos + half));
        let sum = 0;
        for (let i = a; i <= b; i++) sum += data[i];
        out[n++] = sum / (b - a + 1);
      } else {
        const i = Math.floor(pos);
        const f = pos - i;
        out[n++] = data[i] * (1 - f) + data[Math.min(i + 1, data.length - 1)] * f;
      }
      pos += ratio;
    }

    if (n) {
      this.chunks.push(n === out.length ? out : out.subarray(0, n));
      this.length += n;
    }
    const keepFrom = Math.max(0, Math.floor(pos - half) - 1);
    this.carry = data.slice(keepFrom);
    this.pos = pos - keepFrom;
  }

  finish() {
    // Flush the tail by padding with silence.
    this.push(new Float32Array(Math.ceil(this.ratio * 2) + 2));
    const result = new Float32Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }
}

/**
 * Decodes the primary audio track in [start, end) and returns 16 kHz mono
 * Float32 PCM, ready for Whisper.
 */
export async function extractAudio16k(file, { start = 0, end, onProgress, signal } = {}) {
  const TARGET_RATE = 16000;
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new MediaError('No readable audio track found in this video.');
    if (!(await track.canDecode())) {
      throw new MediaError(`This browser cannot decode the ${(await track.getCodec()) ?? 'unknown'} audio track.`);
    }
    end ??= await input.computeDuration();
    const span = Math.max(0.001, end - start);

    const sink = new AudioSampleSink(track);
    let resampler = null;
    let expected = start;

    for await (const sample of sink.samples(start, end)) {
      if (signal?.aborted) {
        sample.close();
        throw new DOMException('Aborted', 'AbortError');
      }
      const rate = sample.sampleRate;
      resampler ??= new StreamingResampler(rate, TARGET_RATE);

      const frames = sample.numberOfFrames;
      const t0 = sample.timestamp;
      const from = Math.max(0, Math.round((start - t0) * rate));
      const to = Math.min(frames, Math.round((end - t0) * rate));

      // Fill gaps in the stream with silence so timestamps stay aligned.
      const gap = Math.max(t0, start) - expected;
      if (gap > 0.01) resampler.push(new Float32Array(Math.round(gap * rate)));

      if (to > from) {
        const channels = sample.numberOfChannels;
        const plane = new Float32Array(frames);
        const mono = new Float32Array(to - from);
        for (let c = 0; c < channels; c++) {
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = from; i < to; i++) mono[i - from] += plane[i] / channels;
        }
        resampler.push(mono);
      }
      expected = Math.max(expected, t0 + frames / rate);
      sample.close();
      onProgress?.(Math.min(1, (expected - start) / span));
    }

    if (!resampler) throw new MediaError('The audio track contained no decodable samples.');
    return resampler.finish();
  } finally {
    input.dispose();
  }
}

/* ------------------------------------------------------------------------
   Burn subtitles
   ------------------------------------------------------------------------ */

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Re-encodes `file` with `cues` burned into every frame. Returns an MP4 Blob
 * plus the codecs used. Rotation is baked in so captions are always upright.
 */
export async function burnSubtitles(file, cues, { onProgress, signal } = {}) {
  const input = openInput(file);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new MediaError('The selected file does not contain a valid video track.');
    const audioTrack = await input.getPrimaryAudioTrack();

    const displayW = await videoTrack.getDisplayWidth();
    const displayH = await videoTrack.getDisplayHeight();
    const width = even(displayW);
    const height = even(displayH);

    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], {
      width,
      height,
      quality: QUALITY_HIGH,
    });
    if (!videoCodec) throw new MediaError('This browser has no WebCodecs video encoder available for MP4.');

    let audioCodec = null;
    if (audioTrack) {
      audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
        numberOfChannels: Math.min(2, await audioTrack.getNumberOfChannels()),
        sampleRate: await audioTrack.getSampleRate(),
      });
    }
    const sourceAudioCodec = audioTrack ? await audioTrack.getCodec() : null;
    // Copy the audio when MP4 can carry it as-is; otherwise transcode.
    const copyAudio = sourceAudioCodec && ['aac', 'opus', 'mp3', 'flac', 'ac3', 'eac3'].includes(sourceAudioCodec);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    const overlays = new SubtitleOverlayCache(cues, width, height);

    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: {
        codec: videoCodec,
        quality: QUALITY_HIGH,
        forceTranscode: true,
        allowTransformationMetadata: false,
        ...(width !== displayW || height !== displayH ? { width, height, fit: 'fill' } : {}),
        processedWidth: width,
        processedHeight: height,
        process: (sample) => {
          sample.drawWithFit(ctx, { fit: 'fill' });
          const overlay = overlays.overlayAt(sample.timestamp + sample.duration / 2);
          if (overlay) ctx.drawImage(overlay, 0, 0);
          return canvas;
        },
      },
      audio: copyAudio || !audioCodec ? {} : { codec: audioCodec },
    });
    assertValid(conversion, 'burn subtitles into this video');
    conversion.onProgress = (p) => onProgress?.(p);

    const unbind = bindAbort(signal, conversion);
    try {
      await conversion.execute();
    } finally {
      unbind();
    }
    return {
      blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
      videoCodec,
      audioCodec: copyAudio ? sourceAudioCodec : audioCodec,
    };
  } finally {
    input.dispose();
  }
}

/** True when the browser has the WebCodecs primitives the pipeline needs. */
export const hasWebCodecs = () =>
  typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
