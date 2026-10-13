/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolveCommandPath: vi.fn(),
  chokidarWatch: vi.fn(),
  fsStat: vi.fn(),
  fsReadFile: vi.fn(),
  fsRealpath: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('node:fs/promises', () => ({
  stat: mocks.fsStat,
  readFile: mocks.fsReadFile,
  realpath: mocks.fsRealpath,
}));

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

vi.mock('chokidar', () => ({
  watch: mocks.chokidarWatch,
}));

import { join, resolve } from 'node:path';

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface PendingCall {
  readonly args: string[];
  readonly callback: ExecCallback;
}

type FakeEntry = { readonly type: 'file'; content: string } | { readonly type: 'dir'; dev?: number };

class FakeWatcher {
  readonly close = vi.fn(() => Promise.resolve());
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

const workDir = resolve('/virtual/repo');
const fakeFiles = new Map<string, FakeEntry>();

let watchers: FakeWatcher[];
let pendingGit: PendingCall[];
let pendingGh: PendingCall[];

beforeEach(() => {
  fakeFiles.clear();
  watchers = [];
  pendingGit = [];
  pendingGh = [];
  delete process.env['GIT_DIR'];
  delete process.env['GIT_CEILING_DIRECTORIES'];
  delete process.env['GIT_DISCOVERY_ACROSS_FILESYSTEM'];
  mocks.resolveCommandPath.mockImplementation((command: string) => `/usr/bin/${command}`);
  mocks.chokidarWatch.mockImplementation(() => {
    const watcher = new FakeWatcher();
    watchers.push(watcher);
    return watcher;
  });
  mocks.execFile.mockImplementation(
    (cmd: string, args: string[], _options: unknown, callback: ExecCallback) => {
      const call: PendingCall = { args, callback };
      if (cmd === '/usr/bin/git') pendingGit.push(call);
      else pendingGh.push(call);
    },
  );
  mocks.fsStat.mockImplementation((path: string) => {
    const entry = fakeFiles.get(path);
    if (entry === undefined) return Promise.reject(enoent(path));
    return Promise.resolve({
      dev: entry.type === 'dir' ? (entry.dev ?? 0) : 0,
      isDirectory: () => entry.type === 'dir',
      isFile: () => entry.type === 'file',
    });
  });
  mocks.fsReadFile.mockImplementation((path: string) => {
    const entry = fakeFiles.get(path);
    if (entry === undefined || entry.type !== 'file') return Promise.reject(enoent(path));
    return Promise.resolve(entry.content);
  });
  mocks.fsRealpath.mockImplementation((path: string) => Promise.resolve(path));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function enoent(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory: ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function writeRepo(dir: string, head = 'ref: refs/heads/main\n'): void {
  fakeFiles.set(join(dir, '.git'), { type: 'dir' });
  fakeFiles.set(join(dir, '.git', 'HEAD'), { type: 'file', content: head });
}

function writeHead(dir: string, content: string): void {
  fakeFiles.set(join(dir, '.git', 'HEAD'), { type: 'file', content });
}

function answer(call: PendingCall, result: string | Error): void {
  if (result instanceof Error) call.callback(result, '', '');
  else call.callback(null, result, '');
}

function answerGitCalls(result: string | Error, match: (args: string[]) => boolean): void {
  const remaining = pendingGit.filter((call) => {
    if (!match(call.args)) return true;
    answer(call, result);
    return false;
  });
  pendingGit.length = 0;
  pendingGit.push(...remaining);
}

async function answerGitRound(status: string | Error, diff: string | Error = ''): Promise<void> {
  await flushMicrotasks();
  answerGitCalls(status, (args) => args.includes('status'));
  await flushMicrotasks();
  answerGitCalls(diff, (args) => args.includes('diff'));
  await flushMicrotasks();
}

function answerGh(result: string | Error): void {
  for (const call of pendingGh.splice(0)) answer(call, result);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const STATUS_DIRTY = '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n';
const DIFF_DIRTY = '4\t1\tsrc/app.ts\n';

describe('git status cache', () => {
  it('shows the branch after the initial async probe and fills in stats asynchronously', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();

    const cache = createGitStatusCache(workDir, { onChange });
    expect(cache.getStatus()).toBeNull();
    await flushMicrotasks();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });

    onChange.mockClear();
    cache.getStatus();
    expect(pendingGit).toHaveLength(0);
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    cache.dispose();
  });

  it('returns the stale value on the TTL-expired frame and refreshes in the background', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();
    onChange.mockClear();

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(cache.getStatus()?.diffAdded).toBe(4);
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-04-24T00:00:31Z'));
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);

    await answerGitRound(
      '## main...origin/main [ahead 3, behind 1]\n M src/app.ts\n',
      '9\t1\tsrc/app.ts\n',
    );
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(cache.getStatus()?.diffAdded).toBe(9);
    expect(cache.getStatus()?.ahead).toBe(3);

    vi.setSystemTime(new Date('2026-04-24T00:01:02Z'));
    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(
      '## main...origin/main [ahead 3, behind 1]\n M src/app.ts\n',
      '9\t1\tsrc/app.ts\n',
    );
    expect(onChange).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('refreshes stats when refresh() is called', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(pendingGit).toHaveLength(0);

    cache.refresh();
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);
    await answerGitRound('## main...origin/main\n M src/app.ts\n', '6\t2\tsrc/app.ts\n');
    expect(cache.getStatus()?.diffAdded).toBe(6);
    cache.dispose();
  });

  it('rereads the branch on HEAD watcher events and debounces stats refreshes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(watchers).toHaveLength(1);
    expect(mocks.chokidarWatch).toHaveBeenCalledWith(
      join(workDir, '.git', 'HEAD'),
      expect.objectContaining({ usePolling: true, interval: 1000, ignoreInitial: true }),
    );

    writeHead(workDir, 'ref: refs/heads/feature\n');
    onChange.mockClear();
    watchers[0]!.emit('change');
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('feature');
    expect(onChange).toHaveBeenCalledTimes(1);

    watchers[0]!.emit('change');
    watchers[0]!.emit('change');
    await flushMicrotasks();
    vi.advanceTimersByTime(999);
    expect(pendingGit).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);

    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    writeHead(workDir, 'ref: refs/heads/from-error-event\n');
    watchers[0]!.emit('error');
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('from-error-event');
    cache.dispose();
  });

  it('shows the short sha for a detached HEAD', async () => {
    writeRepo(workDir, `${'a'.repeat(40)}\n`);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('aaaaaaa');
    cache.dispose();
  });

  it('shows the short sha for a detached HEAD in a SHA-256 repository', async () => {
    writeRepo(workDir, `${'b'.repeat(64)}\n`);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('bbbbbbb');
    cache.dispose();
  });

  it('stops the walk-up at GIT_CEILING_DIRECTORIES', async () => {
    const repoRoot = resolve('/virtual');
    writeRepo(repoRoot, 'ref: refs/heads/parent\n');
    process.env['GIT_CEILING_DIRECTORIES'] = workDir;

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()).toBeNull();
    expect(mocks.chokidarWatch).not.toHaveBeenCalled();
    cache.dispose();
  });

  it('still checks the ceiling directory itself for a repository', async () => {
    writeRepo(workDir);
    process.env['GIT_CEILING_DIRECTORIES'] = workDir;

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('main');
    cache.dispose();
  });

  it('rereads HEAD on watcher ready to cover checkouts before the initial scan', async () => {
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('main');
    onChange.mockClear();

    writeHead(workDir, 'ref: refs/heads/early-checkout\n');
    watchers[0]!.emit('ready');
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('early-checkout');
    expect(onChange).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('stops the walk-up at a filesystem boundary by default', async () => {
    const root = resolve('/');
    fakeFiles.set(workDir, { type: 'dir', dev: 1 });
    fakeFiles.set(resolve('/virtual'), { type: 'dir', dev: 1 });
    fakeFiles.set(root, { type: 'dir', dev: 2 });
    writeRepo(root, 'ref: refs/heads/other-device\n');

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()).toBeNull();
    expect(mocks.chokidarWatch).not.toHaveBeenCalled();
    cache.dispose();
  });

  it('crosses a filesystem boundary when GIT_DISCOVERY_ACROSS_FILESYSTEM is set', async () => {
    const root = resolve('/');
    fakeFiles.set(workDir, { type: 'dir', dev: 1 });
    fakeFiles.set(resolve('/virtual'), { type: 'dir', dev: 1 });
    fakeFiles.set(root, { type: 'dir', dev: 2 });
    writeRepo(root, 'ref: refs/heads/other-device\n');
    process.env['GIT_DISCOVERY_ACROSS_FILESYSTEM'] = 'true';

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('other-device');
    cache.dispose();
  });

  it('does not spawn git or gh when disposed before the deferred refresh runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    cache.getStatus();
    cache.dispose();
    await flushMicrotasks();

    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('falls back to the lexical workDir when realpath fails', async () => {
    writeRepo(workDir);
    mocks.fsRealpath.mockRejectedValue(new Error('EACCES'));

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('main');
    cache.dispose();
  });

  it('resolves a symlinked workDir before walking up', async () => {
    const physicalRoot = resolve('/virtual/physical-repo');
    const physicalApp = join(physicalRoot, 'packages', 'app');
    writeRepo(physicalRoot, 'ref: refs/heads/linked\n');
    const linked = resolve('/virtual/linked-workdir');
    mocks.fsRealpath.mockImplementation((path: string) =>
      Promise.resolve(path === linked ? physicalApp : path),
    );

    const cache = createGitStatusCache(linked);
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('linked');
    expect(mocks.chokidarWatch).toHaveBeenCalledWith(
      join(physicalRoot, '.git', 'HEAD'),
      expect.objectContaining({ usePolling: true }),
    );
    cache.dispose();
  });

  it('lets GIT_DIR win even when a ceiling would block discovery', async () => {
    const gitDir = resolve('/virtual/env-gitdir');
    fakeFiles.set(join(gitDir, 'HEAD'), {
      type: 'file',
      content: 'ref: refs/heads/env-selected\n',
    });
    process.env['GIT_DIR'] = gitDir;
    process.env['GIT_CEILING_DIRECTORIES'] = workDir;

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('env-selected');
    cache.dispose();
  });

  it('resolves a relative gitdir pointer file with a BOM', async () => {
    const gitDir = join(workDir, 'real-git');
    fakeFiles.set(join(gitDir, 'HEAD'), { type: 'file', content: 'ref: refs/heads/worktree\n' });
    const worktree = join(workDir, 'wt');
    fakeFiles.set(join(worktree, '.git'), { type: 'file', content: '\uFEFFgitdir: ../real-git\n' });

    const cache = createGitStatusCache(worktree);
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('worktree');
    expect(mocks.chokidarWatch).toHaveBeenCalledWith(
      join(gitDir, 'HEAD'),
      expect.objectContaining({ usePolling: true }),
    );
    cache.dispose();
  });

  it('honors GIT_DIR from the environment when selecting the repository', async () => {
    const gitDir = resolve('/virtual/env-gitdir');
    fakeFiles.set(join(gitDir, 'HEAD'), {
      type: 'file',
      content: 'ref: refs/heads/env-selected\n',
    });
    process.env['GIT_DIR'] = gitDir;

    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('env-selected');
    expect(mocks.chokidarWatch).toHaveBeenCalledWith(
      join(gitDir, 'HEAD'),
      expect.objectContaining({ usePolling: true }),
    );
    cache.dispose();
  });

  it('finds the repository by walking up from a nested directory', async () => {
    writeRepo(workDir, 'ref: refs/heads/parent\n');
    const nested = join(workDir, 'sub', 'deep');

    const cache = createGitStatusCache(nested);
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('parent');
    cache.dispose();
  });

  it('returns null outside a repo without spawning or watching, and picks up git init within a TTL cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });

    expect(cache.getStatus()).toBeNull();
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(0);
    expect(pendingGh).toHaveLength(0);
    expect(mocks.chokidarWatch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    writeRepo(workDir);
    vi.setSystemTime(new Date('2026-04-24T00:00:10Z'));
    expect(cache.getStatus()).toBeNull();
    await flushMicrotasks();
    expect(cache.getStatus()).toBeNull();

    vi.setSystemTime(new Date('2026-04-24T00:00:31Z'));
    expect(cache.getStatus()).toBeNull();
    await flushMicrotasks();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.getStatus()?.branch).toBe('main');
    expect(mocks.chokidarWatch).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('drops the badge when the repository disappears', async () => {
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();
    expect(cache.getStatus()).not.toBeNull();
    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(new Error('never'));
    onChange.mockClear();

    fakeFiles.delete(join(workDir, '.git', 'HEAD'));
    watchers[0]!.emit('unlink');
    await flushMicrotasks();

    expect(cache.getStatus()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watchers[0]!.close).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('keeps the previous values when git fails and retries on the next TTL cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(cache.getStatus()?.diffAdded).toBe(4);
    onChange.mockClear();

    vi.setSystemTime(new Date('2026-04-24T00:00:31Z'));
    cache.getStatus();
    await answerGitRound(new Error('git failed'));
    expect(onChange).not.toHaveBeenCalled();
    expect(cache.getStatus()?.diffAdded).toBe(4);
    expect(pendingGit).toHaveLength(0);

    vi.setSystemTime(new Date('2026-04-24T00:01:02Z'));
    cache.getStatus();
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(cache.getStatus()?.diffAdded).toBe(4);
    cache.dispose();
  });

  it('still shows the branch from HEAD when git cannot be resolved to a safe path', async () => {
    mocks.resolveCommandPath.mockReturnValue(undefined);
    writeRepo(workDir);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });
    cache.refresh();
    await flushMicrotasks();
    expect(mocks.execFile).not.toHaveBeenCalled();
    cache.dispose();
  });

  it('spawns git and gh through their resolved absolute paths', async () => {
    writeRepo(workDir);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();
    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound('## main...origin/main\n');

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', workDir);
    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('gh', workDir);
    const gitCalls = mocks.execFile.mock.calls.filter(([cmd]) => cmd === '/usr/bin/git');
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]).toEqual([
      '/usr/bin/git',
      expect.arrayContaining(['--no-optional-locks', '-C', workDir, 'status']),
      expect.anything(),
      expect.any(Function),
    ]);
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/gh',
      expect.any(Array),
      expect.anything(),
      expect.any(Function),
    );
    cache.dispose();
  });

  it('re-resolves gh when it was unavailable at startup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    let ghLookups = 0;
    mocks.resolveCommandPath.mockImplementation((command: string) =>
      command === 'git' ? '/usr/bin/git' : ghLookups++ < 2 ? undefined : '/usr/bin/gh',
    );
    writeRepo(workDir);
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    cache.getStatus();
    expect(pendingGh).toHaveLength(0);
    await answerGitRound('## main...origin/main\n');
    expect(cache.getStatus()?.pullRequest).toBeNull();

    vi.setSystemTime(new Date('2026-04-24T00:01:01Z'));
    cache.getStatus();
    await flushMicrotasks();
    expect(pendingGh).toHaveLength(1);
    answerGh('{"number":7,"url":"https://github.com/acme/repo/pull/7"}\n');
    await flushMicrotasks();

    expect(cache.getStatus()?.pullRequest).toEqual({
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
    });

    const lookupsAfterSuccess = ghLookups;
    vi.setSystemTime(new Date('2026-04-24T00:02:02Z'));
    cache.getStatus();
    await flushMicrotasks();
    expect(ghLookups).toBe(lookupsAfterSuccess);
    cache.dispose();
  });

  it('reads current pull request metadata and notifies on change', async () => {
    writeRepo(workDir, 'ref: refs/heads/feature/footer\n');
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();
    onChange.mockClear();

    expect(cache.getStatus()?.pullRequest).toBeNull();
    cache.getStatus();
    await flushMicrotasks();
    answerGh('{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n');
    await answerGitRound(
      '## feature/footer...origin/feature/footer\n M src/app.ts\n',
      '10\t3\tsrc/app.ts\n',
    );

    expect(onChange).toHaveBeenCalled();
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 3,
      pullRequest: {
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
      },
    });
    cache.dispose();
  });

  it('keeps footer git status working when gh pull-request lookup throws synchronously', async () => {
    writeRepo(workDir);
    const onChange = vi.fn();
    mocks.execFile.mockImplementation(
      (cmd: string, args: string[], _options: unknown, callback: ExecCallback) => {
        if (cmd === '/usr/bin/gh') {
          const error = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
          throw error;
        }
        pendingGit.push({ args, callback });
      },
    );
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();

    expect(cache.getStatus()?.branch).toBe('main');
    cache.getStatus();
    await answerGitRound('## main...origin/main\n M src/app.ts\n', '2\t1\tsrc/app.ts\n');

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
    cache.dispose();
  });

  it('discards pending refreshes and closes the watcher on dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();

    cache.getStatus();
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);
    onChange.mockClear();

    writeHead(workDir, 'garbage\n');
    watchers[0]!.emit('change');
    cache.dispose();
    expect(watchers[0]!.close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(pendingGit).toHaveLength(1);

    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(onChange).not.toHaveBeenCalled();
    expect(cache.getStatus()).toBeNull();
  });

  it('treats a .git directory without HEAD as a non-repo', async () => {
    fakeFiles.set(join(workDir, '.git'), { type: 'dir' });
    const cache = createGitStatusCache(workDir);
    await flushMicrotasks();

    expect(cache.getStatus()).toBeNull();
    expect(pendingGit).toHaveLength(0);
    expect(mocks.chokidarWatch).not.toHaveBeenCalled();
    cache.dispose();
  });

  it('keeps the badge when HEAD cannot be parsed but still exists, and recovers on the next event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    await flushMicrotasks();

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound('## main...origin/main\n');
    onChange.mockClear();

    writeHead(workDir, 'garbage\n');
    watchers[0]!.emit('change');
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('main');
    expect(onChange).not.toHaveBeenCalled();
    expect(watchers[0]!.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('main');
    expect(onChange).not.toHaveBeenCalled();

    writeHead(workDir, 'ref: refs/heads/recovered\n');
    watchers[0]!.emit('change');
    await flushMicrotasks();
    expect(cache.getStatus()?.branch).toBe('recovered');
    expect(onChange).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('formats badges from a status snapshot', () => {
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 2,
        behind: 1,
        diffAdded: 12,
        diffDeleted: 3,
        pullRequest: null,
      }),
    ).toBe('main [+12 -3 ↑2↓1]');
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [±]');
  });

  it('formats pull request badges as terminal hyperlinks when requested', () => {
    const linked = formatGitBadge(
      {
        branch: 'feature/footer',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo/pull/12',
        },
      },
      { linkPullRequest: true },
    );

    expect(linked).toContain('[PR#12]');
    expect(linked).toContain('\u001B]8;;https://github.com/acme/repo/pull/12\u0007');
    expect(linked).toContain('\u001B]8;;\u0007');
  });
});
