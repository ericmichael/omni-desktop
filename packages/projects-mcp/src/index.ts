/**
 * Library entry: re-exports `createServer` so the launcher can mount it
 * onto its own HTTP transport in-process. The stdio bin is `cli.ts`.
 */
export { createServer } from './server.js';
