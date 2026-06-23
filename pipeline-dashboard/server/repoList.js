import fs from 'node:fs/promises';
import path from 'node:path';

const GITHUB_URL_RE =
  /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?(?:\s|$|["'])/;

const ALL_GITHUB_URLS_RE = /github\.com[/:][^/\s"']+\/[^/\s"']+?(?:\.git)?(?=["'\s])/g;

export function parseRepoUrl(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(GITHUB_URL_RE);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}

async function walkFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function scanPipelineRepos(epPipelinesPath) {
  const files = await walkFiles(epPipelinesPath);
  const byFullName = new Map();
  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const matches = content.match(ALL_GITHUB_URLS_RE) || [];
    for (const m of matches) {
      const parsed = parseRepoUrl(m + ' ');
      if (parsed) byFullName.set(parsed.fullName, parsed);
    }
  }
  return [...byFullName.values()];
}
