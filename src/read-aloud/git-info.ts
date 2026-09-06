import { spawn as nodeSpawn } from 'child_process';

/**
 * The git fields of a note or a module (`featrues/12-notes/spec.md` §7.3,
 * `featrues/13-classroom/spec.md` §10.2): best effort, two commands with a
 * two-second timeout, argv only, never a shell. Lifted from the notes
 * controller so both features share one copy.
 *
 * Node-only; no `vscode` import, so the runner is unit-testable with an
 * injected `spawn`.
 */

export const GIT_TIMEOUT_MS = 2000;

export interface GitInfo {
  remote: string;
  commit: string;
}

export type GitSpawn = typeof nodeSpawn;

/** `git -C <folder> <args>`: stdout, or '' on any failure or after two seconds. */
export function runGit(
  folderPath: string,
  args: string[],
  spawnFn: GitSpawn = nodeSpawn,
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child: ReturnType<GitSpawn>;
    try {
      child = spawnFn('git', ['-C', folderPath, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish('');
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish('');
    }, GIT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : '');
    });
  });
}

/** The commit and the origin remote of a folder; empty strings when unknown. */
export async function gitInfoFor(
  folderPath: string,
  spawnFn: GitSpawn = nodeSpawn,
): Promise<GitInfo> {
  const commit = await runGit(folderPath, ['rev-parse', 'HEAD'], spawnFn);
  const remote = await runGit(
    folderPath,
    ['config', '--get', 'remote.origin.url'],
    spawnFn,
  );
  return {
    remote: remote.trim().slice(0, 400),
    commit: /^[0-9a-f]{7,64}$/.test(commit.trim()) ? commit.trim() : '',
  };
}

/** Once per folder per session: the promise is cached, the result remembered. */
export class GitInfoCache {
  private readonly pending = new Map<string, Promise<GitInfo>>();
  private readonly known = new Map<string, GitInfo>();
  private readonly spawnFn: GitSpawn;

  constructor(spawnFn: GitSpawn = nodeSpawn) {
    this.spawnFn = spawnFn;
  }

  public get(folderPath: string): Promise<GitInfo> {
    const cached = this.pending.get(folderPath);
    if (cached) {
      return cached;
    }
    const promise = gitInfoFor(folderPath, this.spawnFn).then((info) => {
      this.known.set(folderPath, info);
      return info;
    });
    this.pending.set(folderPath, promise);
    return promise;
  }

  /** What has already been learned about a folder, without waiting. */
  public knownFor(folderPath: string): GitInfo | undefined {
    return this.known.get(folderPath);
  }
}
