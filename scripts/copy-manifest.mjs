// Copies the manifest and icons into dist/ and checks the build is self-contained:
// no remote script URLs and no eval-like constructs in shipped JavaScript (Rule 15).
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
manifest.version = JSON.parse(readFileSync('package.json', 'utf8')).version;
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
cpSync('extension/icons', 'dist/icons', { recursive: true });

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const problems = [];
for (const f of walk('dist')) {
  if (f.endsWith('.html') && /<script[^>]+src=["']https?:/i.test(readFileSync(f, 'utf8'))) problems.push(`${f}: remote script`);
  if (f.endsWith('.js')) {
    const js = readFileSync(f, 'utf8');
    if (/\beval\s*\(/.test(js)) problems.push(`${f}: eval(`);
    if (/new\s+Function\s*\(/.test(js)) problems.push(`${f}: new Function(`);
    if (/import\s*\(\s*["']https?:/.test(js)) problems.push(`${f}: remote import`);
  }
}
if (problems.length) {
  console.error('Build is not self-contained:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('dist/ ready: load it via chrome://extensions → Load unpacked');
