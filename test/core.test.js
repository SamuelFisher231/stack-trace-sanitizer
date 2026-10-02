import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStackTrace,
  sanitizeStack,
  StackFrame,
  defaultSanitizer,
} from '../src/core.js';

/**
 * A representative V8 stack with a leading message line, a node_modules frame,
 * a node:internal frame, and two application frames.
 */
const V8_STACK = `Error: boom
    at handler (/app/src/routes.js:12:9)
    at dispatch (/app/node_modules/express/lib/router/route.js:112:3)
    at node:internal/process/task_queues:96:5
    at bootstrap (/app/src/index.js:3:1)`;

test('parseStackTrace strips the leading error message line', () => {
  const frames = parseStackTrace(V8_STACK);
  assert.equal(frames.length, 4);
  assert.equal(frames[0].functionName, 'handler');
});

test('parseStackTrace extracts file, line, column for a V8 frame', () => {
  const [frame] = parseStackTrace(V8_STACK);
  assert.deepEqual(
    { file: frame.file, line: frame.line, column: frame.column },
    { file: '/app/src/routes.js', line: 12, column: 9 },
  );
});

test('parseStackTrace keeps the original line text on raw', () => {
  const [frame] = parseStackTrace(V8_STACK);
  assert.equal(frame.raw.trim(), 'at handler (/app/src/routes.js:12:9)');
});

test('parseStackTrace handles V8 frames without a function name', () => {
  const stack = `Error: x
    at /app/src/entry.js:5:10`;
  const [frame] = parseStackTrace(stack);
  assert.equal(frame.functionName, '<anonymous>');
  assert.equal(frame.file, '/app/src/entry.js');
  assert.equal(frame.line, 5);
  assert.equal(frame.column, 10);
});

test('parseStackTrace handles V8 frames without a column', () => {
  const stack = `Error: x
    at fn (/app/src/no-col.js:7)`;
  const [frame] = parseStackTrace(stack);
  assert.equal(frame.line, 7);
  assert.ok(Number.isNaN(frame.column));
});

test('parseStackTrace handles anonymous "at <anonymous>" frames', () => {
  const stack = `Error: x
    at <anonymous>`;
  const [frame] = parseStackTrace(stack);
  assert.equal(frame.functionName, '<anonymous>');
  assert.equal(frame.file, '');
  assert.ok(Number.isNaN(frame.line));
  assert.ok(frame.internal);
});

test('parseStackTrace parses SpiderMonkey frames', () => {
  const stack = `fn@file:///app/src/app.js:42:7
@file:///app/src/entry.js:1:1`;
  const frames = parseStackTrace(stack);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].functionName, 'fn');
  assert.equal(frames[0].file, 'file:///app/src/app.js');
  assert.equal(frames[1].functionName, '<anonymous>');
});

test('parseStackTrace returns [] for non-string input', () => {
  assert.deepEqual(parseStackTrace(/** @type {unknown} */ (undefined)), []);
  assert.deepEqual(parseStackTrace(/** @type {unknown} */ (null)), []);
});

test('parseStackTrace ignores non-frame lines without throwing', () => {
  const stack = `Error: x
some prose that is not a frame
    at fn (/app/src/a.js:1:1)`;
  const frames = parseStackTrace(stack);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].functionName, 'fn');
});

test('parseStackTrace tolerates trailing carriage returns', () => {
  const stack = 'Error: x\r\n    at fn (/app/src/a.js:1:1)\r';
  const frames = parseStackTrace(stack);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, '/app/src/a.js');
});

test('sanitizeStack removes node_modules and node:internal frames', () => {
  const frames = sanitizeStack(V8_STACK);
  assert.equal(frames.length, 2);
  assert.deepEqual(
    frames.map((f) => f.functionName),
    ['handler', 'bootstrap'],
  );
  assert.deepEqual(
    frames.map((f) => f.file),
    ['/app/src/routes.js', '/app/src/index.js'],
  );
});

test('sanitizeStack leaves no frames when everything is internal', () => {
  const stack = `Error: x
    at foo (/app/node_modules/a/b.js:1:1)
    at bar (node:internal/c.js:2:2)`;
  assert.deepEqual(sanitizeStack(stack), []);
});

test('StackFrame.toString renders a compact location', () => {
  const [frame] = parseStackTrace(V8_STACK);
  assert.equal(frame.toString(), 'handler (/app/src/routes.js:12:9)');
});

test('StackFrame.toString omits column when missing', () => {
  const stack = `Error: x
    at fn (/app/src/a.js:7)`;
  const [frame] = parseStackTrace(stack);
  assert.equal(frame.toString(), 'fn (/app/src/a.js:7)');
});

test('StackFrame.toString falls back to <unknown> when there is no file', () => {
  const frame = new StackFrame({
    functionName: 'f',
    file: '',
    line: NaN,
    column: NaN,
    internal: true,
    raw: 'at f',
  });
  assert.equal(frame.toString(), 'f (<unknown>)');
});

test('defaultSanitizer accepts an array of StackFrame objects', () => {
  const all = parseStackTrace(V8_STACK);
  const kept = defaultSanitizer.sanitize(all);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((f) => !f.internal));
});

test('StackSanitizer honours extraInternalPatterns', async () => {
  const { StackSanitizer } = await import('../src/core.js');
  const stack = `Error: x
    at a (/app/src/a.js:1:1)
    at b (/app/gen/b.js:2:2)`;
  const sanitizer = new StackSanitizer({
    extraInternalPatterns: ['\\/gen\/'],
  });
  const frames = sanitizer.sanitize(stack);
  assert.deepEqual(
    frames.map((f) => f.file),
    ['/app/src/a.js'],
  );
});
