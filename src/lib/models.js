// Single source of truth lives in the studio workspace package.
// See packages/studio/src/models.js. This file exists only so the
// standalone (Electron/Vite) build's existing imports of "../lib/models"
// keep resolving without touching every consumer.
export * from "studio/src/models.js";

// Inject OpenRouter media-generation models into the shared catalog arrays so
// getVideoModelById / getI2VModelById and the aspect-ratio/duration helpers
// resolve them, while MuapiClient routes their generation to OpenRouter.
// We mutate the exported arrays in place (same reference every consumer holds).
import { t2vModels, i2vModels, t2iModels, v2vModels } from "studio/src/models.js";
import { openrouterVideoModels, openrouterI2VModels, openrouterImageModels } from "./openrouterModels.js";
import { falV2VModels } from "./falModels.js";

function injectOnce(arr, extra) {
  if (!Array.isArray(arr) || !arr.length) return;
  const have = new Set(arr.map((m) => m.id));
  for (const m of extra) if (!have.has(m.id)) arr.push(m);
}

injectOnce(t2vModels, openrouterVideoModels);
injectOnce(i2vModels, openrouterI2VModels);
injectOnce(t2iModels, openrouterImageModels);
// fal.ai video-to-video editing (VACE) into the v2v "tools" catalog.
injectOnce(v2vModels, falV2VModels);
