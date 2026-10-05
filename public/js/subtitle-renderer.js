/* ==========================================================================
   Burned-in subtitle renderer — port of `SubtitleOverlayCache` from
   Sources/WhisperSub/VideoSubtitleBurner.swift. Each cue is rasterized once
   into a transparent overlay canvas and cached, then composited onto every
   frame where the cue is active.
   ========================================================================== */

import { findActiveCue } from './srt.js';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif';

const createCanvas = (w, h) =>
  typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });

/** Wraps text into lines that fit `maxWidth`, breaking on spaces or (for CJK) characters. */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const hasSpaces = /\s/.test(paragraph.trim());
    const tokens = hasSpaces ? paragraph.split(/(\s+)/) : [...paragraph];
    let line = '';
    for (const token of tokens) {
      const candidate = line + token;
      if (line && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        lines.push(line.trim());
        line = token.trimStart();
        // A single token wider than the box: hard-break it by characters.
        while (ctx.measureText(line).width > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Rasterizes one cue into a full-frame transparent canvas. */
export function renderCueOverlay(text, width, height) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const minDimension = Math.min(width, height);
  const fontSize = Math.max(18, Math.min(72, Math.round(minDimension * 0.044)));
  const lineSpacing = Math.max(2, Math.round(fontSize * 0.12));
  const lineHeight = Math.round(fontSize * 1.2) + lineSpacing;

  ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxBoxWidth = width * 0.84;
  let lines = wrapText(ctx, clean, maxBoxWidth);
  // Keep the box within 45% of the frame height, like the native bounding rect.
  const maxLines = Math.max(1, Math.floor((height * 0.45) / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S?$/, '…');
  }

  const textWidth = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)));
  const textHeight = lines.length * lineHeight - lineSpacing;

  const hPad = Math.max(16, Math.round(fontSize * 0.65));
  const vPad = Math.max(10, Math.round(fontSize * 0.36));
  const pillWidth = Math.min(width * 0.92, textWidth + hPad * 2);
  const pillHeight = textHeight + vPad * 2;
  const bottomMargin = Math.max(24, Math.round(height * 0.065));
  const pillX = Math.round((width - pillWidth) / 2);
  const pillY = Math.round(height - bottomMargin - pillHeight);
  const radius = Math.min(14, Math.round(pillHeight * 0.25));

  roundRectPath(ctx, pillX, pillY, pillWidth, pillHeight, radius);
  ctx.fillStyle = 'rgba(10, 10, 10, 0.76)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.stroke();

  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1.5;
  ctx.fillStyle = '#ffffff';
  const firstLineCenter = pillY + vPad + lineHeight / 2 - lineSpacing / 2;
  lines.forEach((line, i) => ctx.fillText(line, width / 2, firstLineCenter + i * lineHeight));

  return canvas;
}

/** Caches one overlay per cue and answers "what should be drawn at time t?". */
export class SubtitleOverlayCache {
  constructor(cues, width, height) {
    this.cues = [...cues].sort((a, b) => a.startTime - b.startTime);
    this.width = width;
    this.height = height;
    this.cache = new Map();
  }

  overlayAt(time) {
    const cue = findActiveCue(this.cues, time);
    if (!cue) return null;
    if (!this.cache.has(cue.id)) {
      this.cache.set(cue.id, renderCueOverlay(cue.text, this.width, this.height));
    }
    return this.cache.get(cue.id);
  }
}
