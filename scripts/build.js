'use strict';

// One-shot page build: publish the browser-compatible engine into the
// static directory served by the HTTP server.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'engine.js');
const dst = path.join(root, 'public', 'engine.js');

const code = fs.readFileSync(src, 'utf8');
if (!code.includes('globalThis.DiscreteEngine')) {
  console.error('build failed: engine.js is missing the browser global export');
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, code);
for (const asset of ['index.html', 'styles.css', 'app.js']) {
  if (!fs.existsSync(path.join(root, 'public', asset))) {
    console.error(`build failed: public/${asset} is missing`);
    process.exit(1);
  }
}
console.log('page build ok: public/engine.js published');
