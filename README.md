# Stack Trace Sanitizer

Parses a V8 or SpiderMonkey stack string and returns only the frames that originate from application source, dropping node_modules and runtime internals.

```js
import { parseStackTrace, sanitizeStack, StackFrame } from 'stack-trace-sanitizer';

const stack = new Error('boom').stack;
const frames = sanitizeStack(stack);            // StackFrame[]
console.log(frames[0].file);                    // /app/src/routes.js
console.log(frames[0].toString());              // handler (/app/src/routes.js:12:9)

// Or parse without filtering:
const all = parseStackTrace(stack);
```

`parseStackTrace(stack: string): StackFrame[]` parses every frame line it recognises. `sanitizeStack(stack: string): StackFrame[]` returns the subset whose `file` does not match the built-in internal patterns. A `StackSanitizer` class is also exported for callers who want to add their own patterns (e.g. a generated-code directory) without losing the defaults.

## Why this exists

`Error.stack` in Node and the browser is useful for triage but noisy: most frames sit in `node_modules`, `node:internal/*`, or browser pseudo-paths. Reading a stack should not require mentally subtracting the framework. This library does one subtractive pass and nothing else.

The trade-off is that filtering is heuristic. It recognises paths by shape — `node_modules/`, `node:internal/`, `node:` scheme, `internal/`, and a small set of browser-internal patterns. If your application lives inside a path that looks like one of those, it will be filtered out. For that case, construct a `StackSanitizer` with `extraInternalPatterns` and use it on the full parse instead, or drop `sanitizeStack` and filter the array yourself.

## Awkward edge

The parser handles V8 (`at fn (file:l:c)`) and SpiderMonkey (`fn@file:l:c`). JSC stack strings follow neither shape and are ignored rather than guessed at: lines that do not match either grammar are dropped, so a Safari stack currently yields `[]` from `parseStackTrace`. This is a deliberate choice over producing half-correct frames.
