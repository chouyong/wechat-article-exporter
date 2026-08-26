import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const exportRoot = path.join(repoRoot, 'data', 'exports', 'article-library');
const libraryRoot = path.join(exportRoot, 'library');
const indexPath = path.join(exportRoot, 'source-index.json');

function normalizePath(input) {
  return input.replaceAll('\\', '/');
}

function canonicalizeUrl(url) {
  const trimmed = `${url || ''}`.trim();
  const matched = /https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/.exec(trimmed);
  return matched ? matched[0] : trimmed;
}

function extractField(markdownText, field) {
  const match = new RegExp(`^${field}:\\s*"([^"]+)"`, 'm').exec(markdownText || '');
  return match?.[1]?.trim() || '';
}

async function readJsonWithFallback(targetPath) {
  const buffer = await fs.readFile(targetPath);
  for (const encoding of ['utf8', 'utf16le', 'latin1']) {
    try {
      return JSON.parse(buffer.toString(encoding).replace(/^\uFEFF/, ''));
    } catch {}
  }
  throw new Error(`无法解析 JSON: ${targetPath}`);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function scanMarkdownFiles(rootDir) {
  const entries = {};
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let dirEntries = [];
    try {
      dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      try {
        const markdownText = await fs.readFile(absolutePath, 'utf8');
        const sourceUrl = canonicalizeUrl(extractField(markdownText, 'source'));
        if (!sourceUrl) continue;
        entries[sourceUrl] = {
          relativePath: normalizePath(path.relative(exportRoot, absolutePath)),
          title: extractField(markdownText, 'title') || path.basename(entry.name, '.md'),
        };
      } catch {}
    }
  }

  return entries;
}

const index = (await fileExists(indexPath)) ? await readJsonWithFallback(indexPath) : { items: {} };
const scanned = await scanMarkdownFiles(libraryRoot);

let added = 0;
let updated = 0;

for (const [sourceUrl, entry] of Object.entries(scanned)) {
  const current = index.items[sourceUrl];
  if (!current) {
    index.items[sourceUrl] = {
      relativePath: entry.relativePath,
      exportedAt: new Date().toISOString(),
      title: entry.title,
    };
    added += 1;
    continue;
  }

  if (current.relativePath !== entry.relativePath || current.title !== entry.title) {
    index.items[sourceUrl] = {
      relativePath: entry.relativePath,
      exportedAt: current.exportedAt || new Date().toISOString(),
      title: entry.title,
    };
    updated += 1;
  }
}

await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

console.log(JSON.stringify({
  scannedCount: Object.keys(scanned).length,
  totalIndexCount: Object.keys(index.items).length,
  added,
  updated,
}, null, 2));
