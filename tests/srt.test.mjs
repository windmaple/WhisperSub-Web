// Unit tests for public/js/srt.js (pure ESM, runs in Node 18+).
import assert from 'node:assert/strict';
import * as S from '../public/js/srt.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('formatTimestamp', () => {
  assert.equal(S.formatTimestamp(0), '00:00:00,000');
  assert.equal(S.formatTimestamp(3.42), '00:00:03,420');
  assert.equal(S.formatTimestamp(3661.0015), '01:01:01,002');
  assert.equal(S.formatTimestamp(-5), '00:00:00,000');
});

t('formatShortTimestamp', () => {
  assert.equal(S.formatShortTimestamp(0), '00:00.0');
  assert.equal(S.formatShortTimestamp(65.44), '01:05.4');
  assert.equal(S.formatShortTimestamp(3725.06), '1:02:05.1');
});

t('parseFlexibleTimestamp', () => {
  assert.equal(S.parseFlexibleTimestamp('10'), 10);
  assert.equal(S.parseFlexibleTimestamp('00:45'), 45);
  assert.equal(S.parseFlexibleTimestamp('1:02:03.5'), 3723.5);
  assert.equal(S.parseFlexibleTimestamp('01:05,5'), 65.5);
  assert.equal(S.parseFlexibleTimestamp(''), null);
  assert.equal(S.parseFlexibleTimestamp('abc'), null);
  assert.equal(S.parseFlexibleTimestamp('1::2'), null);
  assert.equal(S.parseFlexibleTimestamp('-3'), null);
});

t('SRT round trip (CRLF, BOM, multi-line, position metadata)', () => {
  const raw = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500 X1:0\r\nHello\r\nworld\r\n\r\n2\r\n00:00:04.000 --> 00:00:06.000\r\nSecond cue\r\n\r\n\r\ngarbage\r\n';
  const cues = S.parseSRT(raw);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { id: 1, startTime: 1, endTime: 3.5, text: 'Hello\nworld' });
  const out = S.formatSRT(cues);
  assert.equal(out, '1\n00:00:01,000 --> 00:00:03,500\nHello\nworld\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue\n');
  assert.deepEqual(S.parseSRT(out), cues);
});

t('cleanWhisperText', () => {
  assert.equal(S.cleanWhisperText('<|startoftranscript|><|en|> Hello <|0.00|>'), 'Hello');
});

t('buildSubtitleCues splits long captions proportionally', () => {
  const long = 'This is a very long caption that definitely exceeds the eighty eight character limit used by the native app for splitting.';
  const cues = S.buildSubtitleCues([
    { start: 5, end: 6, text: ' second ' },
    { start: 0, end: 4, text: long },
    { start: 7, end: 8, text: '<|0.00|>' },
  ]);
  assert.ok(cues.length >= 3);
  assert.equal(cues[0].startTime, 0);
  assert.ok(cues.every((c) => c.text.length <= 88));
  const split = cues.filter((c) => c.endTime <= 4.0001);
  assert.equal(split.at(-1).endTime, 4);
  assert.equal(cues.at(-1).text, 'second');
  assert.deepEqual(cues.map((c) => c.id), cues.map((_, i) => i + 1));
});

t('buildSubtitleCues splits spaceless CJK text', () => {
  const zh = '今天我们来深入了解苹果神经引擎加速以及如何在本地运行语音识别模型并生成字幕文件然后把字幕烧录到视频当中这是一个非常长的句子需要拆分成多条字幕以便阅读';
  const cues = S.buildSubtitleCues([{ start: 0, end: 10, text: zh }]);
  assert.ok(cues.length > 1, 'should split');
  assert.equal(cues.map((c) => c.text).join(''), zh);
});

t('min duration & findActiveCue', () => {
  const cues = S.buildSubtitleCues([{ start: 2, end: 2, text: 'blip' }, { start: 3, end: 5, text: 'x' }]);
  assert.equal(cues[0].endTime, 2.25);
  assert.equal(S.findActiveCue(cues, 2.1).text, 'blip');
  assert.equal(S.findActiveCue(cues, 2.5), null);
  assert.equal(S.findActiveCue(cues, 4).text, 'x');
});

console.log(`\n${n} tests passed`);

{
  const { buildSubtitleCues: b } = await import('../public/js/srt.js');
  const text = "You can clip any start and end range before transcribing your video, then export a standard";
  const cues = b([{ start: 16.48, end: 21.52, text }]);
  const lens = cues.map(c => c.text.length);
  console.log(cues.length === 2 && Math.min(...lens) > 30 ? 'PASS balanced split' : 'FAIL balanced split ' + JSON.stringify(cues));
}
