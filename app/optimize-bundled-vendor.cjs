'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function fingerprint(directory) {
  const hash = crypto.createHash('sha256');
  function visit(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const source = path.join(current, entry.name);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(source, name);
      else if (entry.isFile()) hash.update(JSON.stringify(name)).update(fs.readFileSync(source));
      else throw new Error(`Unsupported package entry: ${source}`);
    }
  }
  visit(directory);
  return hash.digest('hex');
}

function optimizeVendor(content) {
  const scope = path.join(content, 'vendor', 'node_modules', '@deepseek-ai');
  const candidates = fs.readdirSync(scope, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .map(entry => path.join(scope, entry.name, 'node_modules', 'zod'))
    .filter(directory => fs.existsSync(path.join(directory, 'package.json')));
  if (!candidates.length) return 0;
  const shared = path.join(scope, 'node_modules', 'zod');
  const groups = new Map();
  for (const directory of candidates) {
    const signature = fingerprint(directory);
    const group = groups.get(signature) || [];
    group.push(directory);
    groups.set(signature, group);
  }
  const largest = [...groups.values()].sort((left, right) => right.length - left.length)[0];
  const source = fs.existsSync(shared) ? shared : largest[0];
  const signature = fingerprint(source);
  const identical = groups.get(signature) || [];
  if (source !== shared) fs.cpSync(source, shared, { recursive: true });
  for (const directory of identical) {
    const anchor = path.join(directory, '..', '..', 'package.json');
    fs.rmSync(directory, { recursive: true, force: true });
    const resolved = createRequire(anchor).resolve('zod');
    if (!resolved.startsWith(shared + path.sep)) throw new Error(`Unexpected zod resolution: ${resolved}`);
  }
  console.log(`Bundled vendor: shared ${identical.length} identical zod copies`);
  return identical.length;
}

module.exports = context => optimizeVendor(path.join(context.appOutDir, 'resources', 'content'));
module.exports.optimizeVendor = optimizeVendor;
