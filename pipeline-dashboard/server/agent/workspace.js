import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRepoUrl } from '../repoList.js';

const execFileAsync = promisify(execFile);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultClone(url, dest) {
  await execFileAsync('git', ['clone', url, dest]);
}

// Resolve a repo reference (full URL or owner/name) to a working-copy dir under
// allReposPath, cloning with the token if it isn't present yet.
// owner is accepted now for the multi-user seam but unused single-user.
export async function resolveRepo(
  { allReposPath, token /*, owner */ },
  ref,
  { cloneImpl = defaultClone } = {}
) {
  const trimmed = String(ref).trim();
  // A bare name (no slash) is an already-cloned repo picked from listRepos —
  // resolve it directly to its dir instead of treating it as a GitHub ref.
  if (/^[^/\s]+$/.test(trimmed)) {
    const dir = path.join(allReposPath, trimmed);
    if (await exists(path.join(dir, '.git'))) return dir;
    throw new Error(`No cloned repo named "${trimmed}" in ALL_Repos`);
  }
  // parseRepoUrl only recognizes github.com URLs, so promote a bare owner/name
  // reference to a full URL before parsing.
  const candidate = /^[^/\s]+\/[^/\s]+$/.test(trimmed)
    ? `https://github.com/${trimmed}`
    : trimmed;
  const parsed = parseRepoUrl(candidate + ' ');
  if (!parsed) throw new Error(`Unrecognized repo reference: ${ref}`);
  const dest = path.join(allReposPath, parsed.name);
  if (await exists(path.join(dest, '.git'))) return dest;
  await fs.mkdir(allReposPath, { recursive: true });
  const authUrl = `https://${token}@github.com/${parsed.fullName}.git`;
  await cloneImpl(authUrl, dest);
  return dest;
}

export async function listRepos(allReposPath) {
  let entries;
  try {
    entries = await fs.readdir(allReposPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (await exists(path.join(allReposPath, e.name, '.git'))) names.push(e.name);
  }
  return names;
}
