import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertTrustedDirectory,
  ensureContainedDirectory,
  ensurePrivateDirectory,
} from '../lib/private-directory.ts';
import { isPathInside, samePath } from '../lib/path-identity.ts';

const SKILL_PATH = '.agents/skills/wechat-kf-reply-sop/SKILL.md';

export interface ManagedSkillResult {
  readonly file: string;
  readonly state: 'created' | 'updated' | 'current';
}

export function installManagedSkill({
  packageRoot,
  workingDirectory,
  userHome = os.homedir(),
}: {
  readonly packageRoot: string;
  readonly workingDirectory: string;
  readonly userHome?: string;
}): ManagedSkillResult {
  const workspace = path.resolve(workingDirectory);
  const file = path.join(workspace, SKILL_PATH);
  const bundled = path.join(packageRoot, 'codex-workspace', SKILL_PATH);
  if (samePath(file, bundled)) {
    if (!regularFile(bundled)) {
      throw new Error(`Bundled managed Skill is missing: ${bundled}`);
    }
    return { file, state: 'current' };
  }
  if (process.platform === 'win32' && !isPathInside(userHome, workspace)) {
    throw new Error(
      'The Agent working directory must stay inside the current Windows user profile',
    );
  }
  assertTrustedDirectory(
    ensurePrivateDirectory(workspace),
    'Agent working directory',
    false,
  );
  const directory = ensureContainedDirectory(workspace, path.dirname(file));
  assertTrustedDirectory(directory, 'Managed Skill directory', true);
  const existing = regularFile(file);
  const content = fs.readFileSync(bundled, 'utf8');
  if (existing && fs.readFileSync(file, 'utf8') === content) {
    return { file, state: 'current' };
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { file, state: existing ? 'updated' : 'created' };
}

function regularFile(filePath: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Managed Skill is not a regular file: ${filePath}`);
    }
    return stat;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
