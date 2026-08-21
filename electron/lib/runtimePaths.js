'use strict';

const path = require('node:path');

function resolveRuntimePaths({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  repoRoot = path.join(__dirname, '..', '..'),
} = {}) {
  const root = path.resolve(repoRoot);
  if (!isPackaged) {
    return {
      packaged: false,
      repoRoot: root,
      webDir: null,
      mcpDir: path.join(root, 'mcp'),
      repurposeEngineDir: path.join(root, 'packages', 'repurpose-engine'),
      publicDir: path.join(root, 'public'),
    };
  }
  if (!resourcesPath || !path.isAbsolute(resourcesPath)) {
    throw new Error('Packaged runtime requires an absolute resourcesPath');
  }
  const resources = path.resolve(resourcesPath);
  return {
    packaged: true,
    repoRoot: root,
    webDir: path.join(resources, 'web'),
    mcpDir: path.join(resources, 'mcp'),
    repurposeEngineDir: path.join(resources, 'packages', 'repurpose-engine'),
    publicDir: path.join(resources, 'web', 'public'),
  };
}

module.exports = { resolveRuntimePaths };
