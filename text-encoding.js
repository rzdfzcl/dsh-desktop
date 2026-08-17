'use strict';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function normalizeBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function decodeWithEncoding(buffer, encoding, fatal = false) {
  return new TextDecoder(encoding, { fatal }).decode(buffer);
}

function detectBomEncoding(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  return null;
}

function detectBomlessUtf16(buffer) {
  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 4096);
  if (sampleLength < 4) return null;
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (buffer[index] === 0) evenNuls += 1;
    if (buffer[index + 1] === 0) oddNuls += 1;
  }
  const pairs = sampleLength / 2;
  if (oddNuls / pairs >= 0.3 && evenNuls / pairs <= 0.05) return 'utf-16le';
  if (evenNuls / pairs >= 0.3 && oddNuls / pairs <= 0.05) return 'utf-16be';
  return null;
}

function fallbackEncodings(locale) {
  const language = String(locale || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  if (language.startsWith('zh-tw') || language.startsWith('zh-hk') || language.startsWith('zh-mo')) {
    return ['big5', 'gb18030', 'windows-1252'];
  }
  if (language.startsWith('zh')) return ['gb18030', 'big5', 'windows-1252'];
  if (language.startsWith('ja')) return ['shift_jis', 'windows-1252'];
  if (language.startsWith('ko')) return ['euc-kr', 'windows-1252'];
  if (language.startsWith('ru') || language.startsWith('uk')) return ['windows-1251', 'ibm866', 'windows-1252'];
  return ['windows-1252', 'gb18030', 'big5'];
}

function languageScriptScore(text, locale) {
  const language = String(locale || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  let scriptPattern = null;
  if (language.startsWith('zh')) scriptPattern = /\p{Script=Han}/u;
  else if (language.startsWith('ja')) scriptPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  else if (language.startsWith('ko')) scriptPattern = /[\p{Script=Hangul}\p{Script=Han}]/u;
  else if (language.startsWith('ru') || language.startsWith('uk')) scriptPattern = /\p{Script=Cyrillic}/u;
  if (!scriptPattern) return 0;

  let letters = 0;
  let matching = 0;
  for (const character of text) {
    if (!/[\p{Letter}\p{Number}]/u.test(character)) continue;
    letters += 1;
    if (scriptPattern.test(character)) matching += 1;
  }
  return letters ? matching / letters : 0;
}

function guessBomlessUtf16(buffer, locale, legacyText) {
  if (buffer.length < 4 || buffer.length % 2 !== 0) return null;
  const legacyScore = languageScriptScore(legacyText, locale);
  let best = null;
  for (const encoding of ['utf-16le', 'utf-16be']) {
    try {
      const text = decodeWithEncoding(buffer, encoding, true);
      const score = languageScriptScore(text, locale);
      if (!best || score > best.score) best = { text, encoding, score };
    } catch {
      // Invalid surrogate pairs rule out this byte order.
    }
  }
  return best && best.score >= 0.5 && best.score >= legacyScore + 0.25 ? best : null;
}

function decodeTextBuffer(value, locale) {
  const buffer = normalizeBuffer(value);
  const bomEncoding = detectBomEncoding(buffer);
  if (bomEncoding) return { text: decodeWithEncoding(buffer, bomEncoding), encoding: bomEncoding };

  const utf16Encoding = detectBomlessUtf16(buffer);
  if (utf16Encoding) {
    return { text: decodeWithEncoding(buffer, utf16Encoding, true), encoding: utf16Encoding };
  }

  try {
    return { text: decodeWithEncoding(buffer, 'utf-8', true), encoding: 'utf-8' };
  } catch {
    // Continue with encodings commonly used by the current system locale.
  }

  let legacyResult = null;
  for (const encoding of fallbackEncodings(locale)) {
    try {
      legacyResult = { text: decodeWithEncoding(buffer, encoding, true), encoding };
      break;
    } catch {
      // Try the next compatible legacy encoding.
    }
  }
  if (!legacyResult) {
    legacyResult = { text: decodeWithEncoding(buffer, 'windows-1252'), encoding: 'windows-1252' };
  }
  const utf16Guess = guessBomlessUtf16(buffer, locale, legacyResult.text);
  return utf16Guess || legacyResult;
}

function decodeMixedTextBuffer(value, locale) {
  const buffer = normalizeBuffer(value);
  if (!buffer.length) return { text: '', encoding: 'utf-8' };

  const bomEncoding = detectBomEncoding(buffer);
  const utf16Encoding = detectBomlessUtf16(buffer);
  if (bomEncoding || utf16Encoding) return decodeTextBuffer(buffer, locale);

  const parts = [];
  const encodings = new Set();
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const decoded = decodeTextBuffer(buffer.subarray(start, index), locale);
    parts.push(decoded.text, '\n');
    encodings.add(decoded.encoding);
    start = index + 1;
  }
  if (start < buffer.length) {
    const decoded = decodeTextBuffer(buffer.subarray(start), locale);
    parts.push(decoded.text);
    encodings.add(decoded.encoding);
  }
  return {
    text: parts.join(''),
    encoding: encodings.size === 1 ? [...encodings][0] : `mixed (${[...encodings].join(', ')})`,
  };
}

function isLikelyBinary(value, decoded) {
  const buffer = normalizeBuffer(value);
  const encoding = String(decoded?.encoding || '');
  if (!encoding.startsWith('utf-16') && buffer.includes(0)) return true;
  const text = String(decoded?.text || '');
  if (!text) return false;
  let controls = 0;
  for (const character of text.slice(0, 8192)) {
    const code = character.codePointAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) controls += 1;
  }
  return controls / Math.min(text.length, 8192) > 0.02;
}

module.exports = {
  decodeMixedTextBuffer,
  decodeTextBuffer,
  isLikelyBinary,
};
