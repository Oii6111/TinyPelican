'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const profilePath = path.join(root, 'agent', 'dsh-home', 'profiles', 'xiaotihu', 'package.json');
const installerPath = path.join(root, 'scripts', 'install-dsh-email.ps1');

test('DSH email installer is pinned and does not poison an uninstalled profile', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  assert.match(installer, /fb7a9cbcace860af06c8d415aa85a8c3b21cd30d/);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!fs.existsSync(path.join(root, 'agent', 'dsh-email'))) {
    assert.equal(profile.dependencies?.['dsh-email'], undefined);
    return;
  }
  assert.equal(profile.dependencies?.['dsh-email'], 'link:../../../dsh-email');
  assert.ok(profile.dsh?.profile?.bundles?.includes('dsh-email'));
});
