// @vidmyo/core — one capability layer under the desktop UI, CLI, and MCP.
// Everything here is pure Node ESM: no Electron, no DOM, no localStorage.
// Environment-specific concerns (key storage, IPC, UI state) live in the
// consuming surface and pass values in explicitly.

export * from './src/providers.js';
export * from './src/jobs.js';
export * from './src/project.js';
export * from './src/run.js';
export { falAdapter } from './src/adapters/fal.js';
