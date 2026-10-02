/**
 * Public entry point for the stack-sanitizer library.
 *
 * Only the named exports below are part of the supported API.
 */

export { parseStackTrace, sanitizeStack, StackFrame, defaultSanitizer } from './core.js';
