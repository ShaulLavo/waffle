import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

// Original adapter for the owner's self-extracting design export. No source
// document, React/DC runtime, or extracted reference assets are checked in here.
const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    out: { type: 'string' },
    'landing-id': { type: 'string', default: '281df726-0eff-4ae0-a4d0-749fd2cd790e' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});
if (values.help) {
  console.log('Usage: bun scripts/extract-reference.ts --input /path/to/waffle-website.html --out /new/reference-directory [--landing-id UUID]');
  process.exit(0);
}
if (!values.input || !values.out) throw new Error('Both --input and --out are required; see --help.');

interface Asset {
  mime: string;
  compressed?: boolean;
  data: string;
}
interface ExternalResource {
  id: string;
  uuid: string;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function island(document: string, type: string): unknown {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<script\\b[^>]*\\btype=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'i').exec(document);
  if (!match) throw new Error(`Missing ${type} JSON island`);
  return JSON.parse(match[1]!);
}

function manifest(document: string): Record<string, Asset> {
  const value = island(document, '__bundler/manifest');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid bundle manifest');
  for (const [id, entry] of Object.entries(value)) {
    if (!uuidPattern.test(id) || !entry || typeof entry !== 'object' || typeof entry.mime !== 'string' || typeof entry.data !== 'string' || (entry.compressed !== undefined && typeof entry.compressed !== 'boolean')) {
      throw new Error(`Invalid bundle asset ${id}`);
    }
  }
  return value as Record<string, Asset>;
}

function decode(asset: Asset): Buffer {
  const bytes = Buffer.from(asset.data, 'base64');
  return asset.compressed ? gunzipSync(bytes) : bytes;
}

const input = path.resolve(values.input);
const output = path.resolve(values.out);
const source = await readFile(input);
const pages = manifest(source.toString('utf8'));
const landingId = values['landing-id'];
const landingEntry = pages[landingId];
if (!landingEntry || landingEntry.mime !== 'text/html') throw new Error(`Landing ${landingId} is not an HTML page in the outer manifest`);
const bundledLanding = decode(landingEntry);
const landingDocument = bundledLanding.toString('utf8');
const assets = manifest(landingDocument);
const template = island(landingDocument, '__bundler/template');
if (typeof template !== 'string') throw new Error('Landing template is not a string');
const external = island(landingDocument, '__bundler/ext_resources');
if (!Array.isArray(external) || external.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.uuid !== 'string' || !assets[entry.uuid])) {
  throw new Error('Invalid external resource list');
}

const decoded = Array.from(Object.entries(assets), ([id, asset]) => ({ id, mime: asset.mime, bytes: decode(asset) }));
let html = template;
for (const asset of decoded) html = html.replaceAll(asset.id, `assets/${asset.id}`);

// The export loads these captured dependencies through its wrapper, rather
// than listing them in the HTML template. Restore that order before DC boots:
// React, ReactDOM, then the existing DC/Three/scene scripts. Never fetch a CDN.
const dependencyTags = (external as ExternalResource[]).map(entry => {
  if (!/^(?:text|application)\/javascript$/.test(assets[entry.uuid]!.mime)) {
    throw new Error(`Unsupported captured dependency MIME type for ${entry.uuid}`);
  }
  return `<script src="assets/${entry.uuid}"></script>`;
}).join('');
if (!/<script\b/i.test(html)) throw new Error('Landing template has no script insertion point');
html = html.replace(/<script\b/i, `${dependencyTags}<script`);

// Refuse to merge into or overwrite existing data. Decode/validate all inputs
// before claiming a new directory, and remove only our partial output on error.
await mkdir(output);
try {
  await mkdir(path.join(output, 'assets'));
  await writeFile(path.join(output, 'landing.bundle.html'), bundledLanding);
  await writeFile(path.join(output, 'index.html'), html);
  for (const asset of decoded) await writeFile(path.join(output, 'assets', asset.id), asset.bytes);
  const metadata = {
    sourceSha256: sha256(source),
    sourceBytes: source.length,
    landingId,
    bundledLandingSha256: sha256(bundledLanding),
    bundledLandingBytes: bundledLanding.length,
    runnableHtmlSha256: sha256(Buffer.from(html)),
    runnableHtmlBytes: Buffer.byteLength(html),
    assets: decoded.map(asset => ({ id: asset.id, mime: asset.mime, bytes: asset.bytes.length, sha256: sha256(asset.bytes) })),
  };
  await writeFile(path.join(output, 'reference.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...metadata }, null, 2));
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
