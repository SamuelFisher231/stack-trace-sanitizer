/**
 * Stack Trace Sanitizer — core parsing and filtering logic.
 *
 * Parses a stack-trace string produced by V8 (Node.js, Chromium) or SpiderMonkey
 * (Firefox) into a list of StackFrame records, then strips frames that live in
 * node_modules or well-known browser/vm internals. The caller gets only the
 * frames that originated from application source.
 */

/**
 * A single frame of a parsed stack trace.
 */
export class StackFrame {
  /**
   * @param {object}  parts
   * @param {string}  parts.functionName Function name as printed, or '<anonymous>'.
   * @param {string}  parts.file         File URL / path.
   * @param {number}  parts.line         1-based line number, or NaN if absent.
 * @param {number}  parts.column       1-based column number, or NaN if absent.
   * @param {boolean} parts.internal    True when the frame was classified as
   *                                    runtime / vm internal at parse time.
   * @param {string}  parts.raw         The original, unparsed frame text.
   */
  constructor({ functionName, file, line, column, internal, raw }) {
    this.functionName = functionName;
    this.file = file;
    this.line = line;
    this.column = column;
    this.internal = internal;
    this.raw = raw;
  }

  /**
   * Compact, human-readable rendering. Intentionally not a re-parseable stack
   * string — the goal is a readable signal for logs and error reports.
   */
  toString() {
    const where = this.file
      ? `${this.file}:${this.line}${Number.isNaN(this.column) ? '' : `:${this.column}`}`
      : '<unknown>';
    return `${this.functionName} (${where})`;
  }
}

/**
 * Heuristic file/URL patterns for runtime and browser internals. These are the
 * noisy frames that appear below user code in both Node and the browser and
 * almost never help during triage.
 */
const INTERNAL_PATTERNS = [
  /\bnode:internal\//,                    // Node internal modules (node:fs etc.)
  /^internal\//,                          // Node internal paths, pre node: scheme
  /\/lib\/internal\//,                    // Node.js source layout
  /\bnode_modules\//,                     // dependencies
  /^node:/,                               // bare node: scheme modules
  /\bevalmachine\./,                      // vm module eval
  /^eval at /,                            // eval entry frames
  /^bootstrap_node/,                      // legacy Node bootstrap
  /^node_modules\.\//,                    // Node.js ESM bare-specifier frames
  // Common browser-internal pseudo-paths. They lack a scheme but are stable
  // enough to recognise by shape.
  /^https?:\/\/[^/]+\/(api|node|deno)\//,
  /^\[native code\]$/,
];

/**
 * Detect whether a file path / URL belongs to a runtime or library that we
 * treat as non-application noise.
 *
 * @param {string} file
 * @returns {boolean}
 */
function isInternalFile(file) {
  if (!file) return true; // frame with no location at all is internal by definition
  return INTERNAL_PATTERNS.some((re) => re.test(file));
}

/**
 * V8 frame shape. Two common forms:
 *   at functionName (file:line:col)
 *   at file:line:col
 * The function group may itself be an eval wrapper, e.g.
 *   at Object.<anonymous> (/path/x.js:1:2)
 */
const V8_LINE = /^\s*at\s+(.*)$/;
const V8_PARENS =
  /^(.*?)\s+\((.*?):(\d+)(?::(\d+))?\)\s*$/;
const V8_BARE = /^(.*?):(\d+)(?::(\d+))?\s*$/;

/**
 * SpiderMonkey frame shape, e.g.
 *   functionName@file:line:col
 * or @file:line:col when the function is anonymous.
 */
const SPIDERMONKEY_LINE = /^(.*?)@(.*?):(\d+)(?::(\d+))?\s*$/;

/**
 * Build a StackFrame from parsed components, defaulting to NaN for missing
 * numeric fields so consumers can rely on a stable number-or-NaN contract.
 */
function buildFrame(functionName, file, lineStr, columnStr, raw) {
  const line = Number(lineStr);
  const column = columnStr === undefined ? NaN : Number(columnStr);
  return new StackFrame({
    functionName: functionName || '<anonymous>',
    file,
    line,
    column,
    internal: isInternalFile(file),
    raw,
  });
}

/**
 * Parse one frame line into a StackFrame, or null if the line is not a frame
 * at all (e.g. the leading "Error:" message line).
 *
 * We support V8 and SpiderMonkey; JSC frames are rare in stack strings and
 * follow neither shape closely, so we treat them as unparseable rather than
 * guessing.
 */
function parseFrame(line) {
  const raw = line;

  // V8 "at ..." form with parentheses.
  const v8Match = V8_LINE.exec(line);
  if (v8Match) {
    const body = v8Match[1];
    const parens = V8_PARENS.exec(body);
    if (parens) {
      const [, fn, file, l, c] = parens;
      return buildFrame(fn, file, l, c, raw);
    }
    const bare = V8_BARE.exec(body);
    if (bare) {
      const [, file, l, c] = bare;
      return buildFrame('', file, l, c, raw);
    }
    // "at <anonymous>" with no location: classify as internal.
    return new StackFrame({
      functionName: body || '<anonymous>',
      file: '',
      line: NaN,
      column: NaN,
      internal: true,
      raw,
    });
  }

  // SpiderMonkey "fn@file:line:col" form.
  const sm = SPIDERMONKEY_LINE.exec(line);
  if (sm) {
    const [, fn, file, l, c] = sm;
    return buildFrame(fn, file, l, c, raw);
  }

  return null;
}

/**
 * Parse a stack-trace string into an array of StackFrame records.
 *
 * The leading line of an Error.stack string is typically the error message and
 * is silently dropped. Non-frame lines are ignored. Unparseable frames are not
 * included in the result; use `raw` on each returned frame if you need the
 * verbatim text.
 *
 * @param {string} stack A stack trace string, e.g. from `new Error().stack`.
 * @returns {StackFrame[]} Parsed frames in call order (most-recent first).
 */
export function parseStackTrace(stack) {
  if (typeof stack !== 'string') {
    return [];
  }
  const lines = stack.split('\n');
  const frames = [];
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    const frame = parseFrame(trimmed);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * A configurable sanitizer. Exposed so callers can tweak the heuristic if they
 * have a custom build directory layout, while still using the same parser.
 */
export class StackSanitizer {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.extraInternalPatterns] Extra regex sources treated
   *   as internal. Each is compiled with `new RegExp(source)`.
   */
  constructor({ extraInternalPatterns = [] } = {}) {
    this.extra = extraInternalPatterns.map((s) => new RegExp(s));
  }

  /**
   * @param {string|StackFrame} frameOrStack
   * @returns {StackFrame[]} Application frames only.
   */
  sanitize(frameOrStack) {
    const frames =
      typeof frameOrStack === 'string'
        ? parseStackTrace(frameOrStack)
        : Array.isArray(frameOrStack)
          ? frameOrStack
          : [frameOrStack];

    return frames.filter((f) => !this._isInternal(f));
  }

  /** @param {StackFrame} frame */
  _isInternal(frame) {
    if (frame.internal) return true;
    if (!frame.file) return true;
    return this.extra.some((re) => re.test(frame.file));
  }
}

/**
 * Default sanitizer with the built-in internal patterns only.
 */
export const defaultSanitizer = new StackSanitizer();

/**
 * Convenience wrapper: parse a stack string and return only the application
 * frames, using the default internal-file heuristics.
 *
 * @param {string} stack
 * @returns {StackFrame[]}
 */
export function sanitizeStack(stack) {
  return defaultSanitizer.sanitize(stack);
}
