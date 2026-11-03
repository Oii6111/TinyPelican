'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDITIONS_API_VERSION = 1;
const DEFAULT_EDITION_ID = 'base';

function editionsRoot(projectRoot) { return path.join(projectRoot, 'editions'); }
function safeEditionId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : ''; }

function readManifest(projectRoot, id) {
  const safeId = safeEditionId(id);
  if (!safeId) return null;
  try {
    const file = path.join(editionsRoot(projectRoot), safeId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.id !== safeId || manifest.apiVersion !== EDITIONS_API_VERSION) return null;
    if (manifest.presetCode && typeof manifest.presetCode !== 'string') return null;
    return { ...manifest, resourceDir: path.dirname(file) };
  } catch { return null; }
}

function listEditions(projectRoot) {
  try {
    return fs.readdirSync(editionsRoot(projectRoot), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => readManifest(projectRoot, entry.name))
      .filter(Boolean)
      .map(publicManifest);
  } catch { return []; }
}

function publicManifest(manifest) {
  const { resourceDir, presetCode, ...safe } = manifest;
  return { ...safe, hasPresetCode: Boolean(presetCode) };
}

function resolveEdition(projectRoot, codeOrId) {
  const value = String(codeOrId || '').trim();
  try {
    return fs.readdirSync(editionsRoot(projectRoot), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => readManifest(projectRoot, entry.name))
      .find(manifest => manifest && (manifest.id === value || manifest.presetCode === value)) || null;
  } catch { return null; }
}

function editionStatePath(stableUserData) { return path.join(stableUserData, 'edition.json'); }

function readActiveEdition(stableUserData, projectRoot) {
  let id = DEFAULT_EDITION_ID;
  try {
    const state = JSON.parse(fs.readFileSync(editionStatePath(stableUserData), 'utf8'));
    if (safeEditionId(state.editionId)) id = state.editionId;
  } catch {}
  return readManifest(projectRoot, id) || readManifest(projectRoot, DEFAULT_EDITION_ID);
}

function saveActiveEdition(stableUserData, manifest) {
  fs.mkdirSync(stableUserData, { recursive: true });
  fs.writeFileSync(editionStatePath(stableUserData), JSON.stringify({ editionId: manifest.id, selectedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

function editionDataDir(stableUserData, manifest) {
  return manifest.id === DEFAULT_EDITION_ID ? stableUserData : path.join(stableUserData, 'editions', manifest.id);
}

function manifestDigest(manifest) { return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'); }

module.exports = { EDITIONS_API_VERSION, DEFAULT_EDITION_ID, editionsRoot, editionStatePath, editionDataDir, listEditions, readManifest, readActiveEdition, resolveEdition, saveActiveEdition, manifestDigest };
