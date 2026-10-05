/* ==========================================================================
   SRT formatting / parsing — a faithful port of `SRTFormatter` and
   `SubtitleCue` from Sources/WhisperSub/SubtitleModels.swift.
   ========================================================================== */

/**
 * @typedef {Object} SubtitleCue
 * @property {number} id
 * @property {number} startTime  seconds
 * @property {number} endTime    seconds
 * @property {string} text
 */

/** Creates a normalized cue (mirrors the Swift `SubtitleCue` initializer). */
export function makeCue(id, startTime, endTime, text) {
  const start = Math.max(0, startTime);
  return {
    id,
    startTime: start,
    endTime: Math.max(start + 0.05, endTime),
    text: String(text ?? '').trim(),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Formats seconds into the standard SRT timestamp `HH:MM:SS,mmm`. */
export function formatTimestamp(seconds) {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Formats seconds into a compact `MM:SS.d` (or `H:MM:SS.d`) string for the UI. */
export function formatShortTimestamp(seconds) {
  const totalTenths = Math.round(Math.max(0, seconds) * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${tenths}` : `${pad(m)}:${pad(s)}.${tenths}`;
}

/** Generates a complete `.srt` file string from an array of cues. */
export function formatSRT(cues) {
  if (!cues.length) return '';
  return (
    cues
      .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startTime)} --> ${formatTimestamp(cue.endTime)}\n${cue.text.trim()}`)
      .join('\n\n') + '\n'
  );
}

/** Parses `HH:MM:SS,mmm` or `HH:MM:SS.mmm` into seconds. */
export function parseTimestamp(raw) {
  const token = raw.trim().split(/\s+/)[0] ?? '';
  const parts = token.replace(',', '.').split(':');
  if (parts.length !== 3) return null;
  const [h, m, s] = parts.map(Number);
  if (![h, m, s].every(Number.isFinite)) return null;
  return h * 3600 + m * 60 + s;
}

/** Parses a `.srt` file string into cues. Also tolerates WebVTT-style blocks. */
export function parseSRT(content) {
  const normalized = String(content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];

  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;

    const [rawStart, rawEnd] = lines[timeIdx].split('-->');
    if (rawEnd === undefined) continue;
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (start === null || end === null) continue;

    const text = lines.slice(timeIdx + 1).join('\n').trim();
    if (!text) continue;

    cues.push(makeCue(cues.length + 1, start, end, text));
  }
  return cues;
}

/** Parses flexible user-entered times (`HH:MM:SS[.mmm]`, `MM:SS[.mmm]`, or `SS[.mmm]`) into seconds. */
export function parseFlexibleTimestamp(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const parts = trimmed.replace(',', '.').split(':');
  if (parts.length < 1 || parts.length > 3) return null;
  if (parts.some((p) => p.trim() === '' || !/^\d*\.?\d+$/.test(p.trim()))) return null;
  const nums = parts.map(Number);
  let result = 0;
  for (const n of nums) result = result * 60 + n;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/** Strips Whisper special tokens such as `<|startoftranscript|>` or `<|0.00|>`. */
export function cleanWhisperText(raw) {
  return String(raw ?? '')
    .replace(/<\|[^>]*\|>/g, '')
    .trim();
}

/** Returns the cue active at `time` (cues must be sorted by start time). */
export function findActiveCue(cues, time) {
  for (const cue of cues) {
    if (time >= cue.startTime && time <= cue.endTime) return cue;
    if (cue.startTime > time) break;
  }
  return null;
}

/**
 * Splits a long caption into chunks of at most `maxChars`, distributing the
 * time span proportionally to text length (port of `splitLongCaption`).
 * Falls back to character-level splitting for scripts without spaces (CJK).
 */
function splitLongCaption(text, start, end, maxChars) {
  // Spaceless scripts (Chinese/Japanese/Thai…) have wide glyphs, so they get a
  // tighter character budget and are split per character instead of per word.
  const spaceless = !/\s/.test(text.trim()) || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
  const cjkBudget = Math.max(16, Math.round(maxChars / 2.5));
  const limit = spaceless && /[^\x00-\u024f]/.test(text) ? cjkBudget : maxChars;
  if ([...text].length <= limit || end <= start + 0.8) return [{ start, end, text }];

  let words = text.split(' ').filter(Boolean);
  let joiner = ' ';
  if (limit === cjkBudget && (words.length < 4 || /[\u3040-\u30ff\u3400-\u9fff]/.test(text))) {
    words = [...text.replace(/\s+/g, '')];
    joiner = '';
  } else if (words.length < 4) {
    return [{ start, end, text }];
  }
  maxChars = limit;

  const greedy = (budget) => {
    const out = [];
    let current = [];
    let currentLen = 0;
    for (const word of words) {
      const len = [...word].length;
      const addition = current.length === 0 ? len : len + joiner.length;
      if (currentLen + addition > budget && current.length) {
        out.push(current.join(joiner));
        current = [word];
        currentLen = len;
      } else {
        current.push(word);
        currentLen += addition;
      }
    }
    if (current.length) out.push(current.join(joiner));
    return out;
  };

  // Greedy filling (the native behaviour) can leave a one-word orphan cue.
  // Keep the same number of chunks but balance their lengths.
  let chunks = greedy(maxChars);
  const fullLen = [...words.join(joiner)].length;
  for (let budget = Math.ceil(fullLen / chunks.length); budget < maxChars; budget++) {
    const balanced = greedy(budget);
    if (balanced.length <= chunks.length) { chunks = balanced; break; }
  }

  const totalChars = Math.max(1, chunks.reduce((acc, c) => acc + [...c].length, 0));
  const totalDuration = end - start;
  let cursor = start;
  return chunks.map((chunk, idx) => {
    const segEnd = idx === chunks.length - 1 ? end : cursor + totalDuration * ([...chunk].length / totalChars);
    const out = { start: cursor, end: segEnd, text: chunk };
    cursor = segEnd;
    return out;
  });
}

/**
 * Converts raw Whisper segments (`{start, end, text}`) into clean, well-timed
 * cues (port of `buildSubtitleCues`).
 */
export function buildSubtitleCues(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const cues = [];
  for (const segment of sorted) {
    const cleaned = cleanWhisperText(segment.text);
    if (!cleaned) continue;
    const start = segment.start;
    const end = Math.max(start + 0.25, segment.end);
    for (const sub of splitLongCaption(cleaned, start, end, 88)) {
      cues.push(makeCue(cues.length + 1, sub.start, sub.end, sub.text));
    }
  }
  return cues;
}

/** Re-sequences cue ids so they're 1-based and contiguous. */
export function renumber(cues) {
  return cues.map((c, i) => ({ ...c, id: i + 1 }));
}
