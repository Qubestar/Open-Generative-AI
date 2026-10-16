// Vidmyo home-directory resolution — one function every surface shares.
//
// The implementation lives in `paths.cjs` so the Electron main-process
// bridges (CommonJS) and this ESM package resolve the same value:
//   production  -> `~/.vidmyo` (shared jobs/, exports/, governor/, queue)
//   tests       -> `VIDMYO_HOME` (private mkdtemp), set by
//                  `test/_setup/runIsolated.mjs`
// `HOME` is deliberately never overridden — puppeteer/HyperFrames caches,
// Homebrew FFmpeg discovery and Chrome profiles all depend on it, and
// overriding it would hide regressions rather than expose them.

import paths from './paths.cjs';

export const VIDMYO_HOME_ENV = paths.VIDMYO_HOME_ENV;
export const TEST_RUN_ENV = paths.TEST_RUN_ENV;
export const vidmyoHome = paths.vidmyoHome;
export const testRunMarker = paths.testRunMarker;
