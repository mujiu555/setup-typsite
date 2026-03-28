import * as core from '@actions/core';
import * as github from '@actions/github';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OWNER = 'Glomzzz';
const REPO = 'typsite';

function getTargetCandidates(platform, arch) {
  if (platform === 'win32' && arch === 'x64') {
    return [
      'x86_64-pc-windows-msvc',
      'x86_64-windows',
      'windows-x86_64',
      'win64',
      'win-x64',
      'windows-amd64',
    ];
  }

  if (platform === 'darwin' && arch === 'x64') {
    return [
      'x86_64-apple-darwin',
      'darwin-x86_64',
      'macos-x86_64',
      'apple-darwin',
    ];
  }

  if (platform === 'darwin' && arch === 'arm64') {
    return [
      'aarch64-apple-darwin',
      'arm64-apple-darwin',
      'macos-arm64',
      'apple-darwin',
    ];
  }

  if (platform === 'linux' && arch === 'x64') {
    return [
      'x86_64-unknown-linux-gnu',
      'x86_64-unknown-linux-musl',
      'x86_64-linux',
      'linux-x86_64',
      'linux-amd64',
      'x86_64-gnu',
      'x86_64-musl',
    ];
  }

  if (platform === 'linux' && arch === 'arm64') {
    return [
      'aarch64-unknown-linux-gnu',
      'aarch64-unknown-linux-musl',
      'arm64-unknown-linux-gnu',
      'linux-aarch64',
      'linux-arm64',
    ];
  }

  return [];
}

function scoreAsset(name, platform, candidates) {
  const lower = name.toLowerCase();
  if (/(sha256|checksum|\.sig|\.asc)$/.test(lower)) {
    return -100;
  }

  let score = 0;
  if (candidates.some((candidate) => lower.includes(candidate))) {
    score += 100;
  }

  const prefersZip = platform === 'win32';
  if (prefersZip && lower.endsWith('.zip')) {
    score += 20;
  }

  if (!prefersZip && (lower.endsWith('.tar.gz') || lower.endsWith('.tgz'))) {
    score += 20;
  }

  if (lower.endsWith('.exe')) {
    score += 10;
  }

  return score;
}

async function downloadToFile(url, destination, headers, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await fsPromises.mkdir(path.dirname(destination), { recursive: true });

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, url).toString();
        downloadToFile(redirectUrl, destination, headers, redirects + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url} (status ${response.statusCode})`));
        response.resume();
        return;
      }

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(resolve));
      fileStream.on('error', reject);
    });

    request.on('error', reject);
  });
}

async function extractArchive(archivePath, destination, platform) {
  if (archivePath.endsWith('.zip')) {
    await fsPromises.mkdir(destination, { recursive: true });

    if (platform === 'win32') {
      await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${destination}" -Force`,
      ]);
    } else {
      await execFileAsync('unzip', ['-q', archivePath, '-d', destination]);
    }
    return;
  }

  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    await fsPromises.mkdir(destination, { recursive: true });
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destination]);
    return;
  }

  throw new Error(`Unsupported archive format: ${archivePath}`);
}

async function findBinary(searchDir, platform) {
  const entries = await fsPromises.readdir(searchDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(searchDir, entry.name);
    if (entry.isDirectory()) {
      const found = await findBinary(entryPath, platform);
      if (found) {
        return found;
      }
      continue;
    }

    if (platform === 'win32' && entry.name.toLowerCase() === 'typsite.exe') {
      return entryPath;
    }

    if (platform !== 'win32' && entry.name === 'typsite') {
      return entryPath;
    }

    if (platform !== 'win32' && entry.name.startsWith('typsite') && !entry.name.includes('.')) {
      return entryPath;
    }
  }

  return null;
}

async function resolveRelease(octokit, versionInput) {
  if (versionInput === 'latest') {
    const { data } = await octokit.rest.repos.getLatestRelease({
      owner: OWNER,
      repo: REPO,
    });
    return data;
  }

  const candidateTags = [];
  if (versionInput.startsWith('v')) {
    candidateTags.push(versionInput);
  } else {
    candidateTags.push(`v${versionInput}`, versionInput);
  }

  for (const tag of candidateTags) {
    try {
      const { data } = await octokit.rest.repos.getReleaseByTag({
        owner: OWNER,
        repo: REPO,
        tag,
      });
      return data;
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  throw new Error(`No release found for version "${versionInput}".`);
}

async function run() {
  const versionInput = core.getInput('version') || 'latest';
  const token = process.env.GITHUB_TOKEN || '';
  const octokit = github.getOctokit(token);

  const platform = os.platform();
  const arch = os.arch();

  const candidates = getTargetCandidates(platform, arch);
  if (candidates.length === 0) {
    throw new Error(`Unsupported platform/arch combo: ${platform}/${arch}`);
  }

  core.info(`Resolving typsite ${versionInput} release...`);
  const release = await resolveRelease(octokit, versionInput);
  const assets = release.assets || [];

  if (!assets.length) {
    throw new Error(`No assets found in release "${release.tag_name}".`);
  }

  let bestAsset = null;
  let bestScore = -Infinity;
  for (const asset of assets) {
    if (!asset.name || !asset.browser_download_url) {
      continue;
    }
    const score = scoreAsset(asset.name, platform, candidates);
    if (score > bestScore) {
      bestScore = score;
      bestAsset = asset;
    }
  }

  if (!bestAsset || bestScore < 0) {
    const assetNames = assets.map((asset) => asset.name).join(', ');
    throw new Error(
      `Unable to find a matching typsite asset for ${platform}/${arch}. Available assets: ${assetNames}`
    );
  }

  core.info(`Downloading ${bestAsset.name}...`);
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'typsite-'));
  const downloadPath = path.join(tempDir, bestAsset.name);
  await downloadToFile(bestAsset.browser_download_url, downloadPath);

  let binaryPath = null;
  if (bestAsset.name.endsWith('.zip') || bestAsset.name.endsWith('.tar.gz') || bestAsset.name.endsWith('.tgz')) {
    const extractDir = path.join(tempDir, 'extract');
    await extractArchive(downloadPath, extractDir, platform);
    binaryPath = await findBinary(extractDir, platform);
  } else if (bestAsset.name.endsWith('.exe') || bestAsset.name.startsWith('typsite')) {
    binaryPath = downloadPath;
  }

  if (!binaryPath) {
    throw new Error(`Downloaded asset does not contain a typsite binary: ${bestAsset.name}`);
  }

  if (platform !== 'win32') {
    await fsPromises.chmod(binaryPath, 0o755);
  }

  core.addPath(path.dirname(binaryPath));
  core.setOutput('version', release.tag_name || versionInput);
  core.info(`typsite ${release.tag_name || versionInput} installed.`);
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
