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

// Fetch latest on an existing clone. Best-effort: a pull failure (offline, dirty
// tree, detached HEAD) must not block starting a session on the code already there.
async function defaultPull(dir) {
  try {
    await execFileAsync('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 60000 });
  } catch {
    /* keep the existing checkout */
  }
}

// Resolve a repo reference (full URL or owner/name) to a working-copy dir under
// allReposPath, cloning with the token if it isn't present yet.
// owner is accepted now for the multi-user seam but unused single-user.
export async function resolveRepo(
  { allReposPath, token, owner },
  ref,
  { cloneImpl = defaultClone, pullImpl = defaultPull } = {}
) {
  const trimmed = String(ref).trim();
  // A bare name (no slash) is usually an already-cloned repo picked from listRepos.
  // If it isn't cloned yet, promote it to {owner}/{name} and clone it on demand —
  // so typing a name works the same as pasting a link (provided a default owner
  // is configured). Without an owner we can't know where to clone from.
  if (/^[^/\s]+$/.test(trimmed)) {
    const dir = path.join(allReposPath, trimmed);
    if (await exists(path.join(dir, '.git'))) {
      await pullImpl(dir);
      return dir;
    }
    if (!owner) {
      throw new Error(
        `"${trimmed}" isn't cloned in ALL_Repos. Paste its GitHub link, or set GITHUB_OWNER to clone by name.`
      );
    }
    return resolveRepo({ allReposPath, token, owner }, `${owner}/${trimmed}`, { cloneImpl, pullImpl });
  }
  // parseRepoUrl only recognizes github.com URLs, so promote a bare owner/name
  // reference to a full URL before parsing.
  const candidate = /^[^/\s]+\/[^/\s]+$/.test(trimmed)
    ? `https://github.com/${trimmed}`
    : trimmed;
  const parsed = parseRepoUrl(candidate + ' ');
  if (!parsed) throw new Error(`Unrecognized repo reference: ${ref}`);
  const dest = path.join(allReposPath, parsed.name);
  // Existing clone → fetch latest and reuse; otherwise clone fresh.
  if (await exists(path.join(dest, '.git'))) {
    await pullImpl(dest);
    return dest;
  }
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
