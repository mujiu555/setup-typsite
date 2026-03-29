import * as core from '@actions/core';
import * as io from '@actions/io';
import os from 'node:os';
import path from 'node:path';

function isSafeTempPath(targetPath) {
  if (!targetPath) {
    return false;
  }
  const resolvedTarget = path.resolve(targetPath);
  const resolvedTmp = path.resolve(os.tmpdir());
  return resolvedTarget.startsWith(`${resolvedTmp}${path.sep}`);
}

async function run() {
  const tempDir = core.getState('tempDir');
  if (!tempDir) {
    core.info('No temp directory state found. Skipping cleanup.');
    return;
  }

  if (!isSafeTempPath(tempDir)) {
    core.warning(`Refusing to clean unexpected path: ${tempDir}`);
    return;
  }

  core.info(`Cleaning up temp directory: ${tempDir}`);
  await io.rmRF(tempDir);
}

run().catch((error) => {
  core.warning(error instanceof Error ? error.message : String(error));
});
