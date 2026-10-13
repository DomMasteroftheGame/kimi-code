/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolveCommandPath: vi.fn(),
  chokidarWatch: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

vi.mock('chokidar', () => ({
  watch: mocks.chokidarWatch,
}));

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface PendingCall {
  readonly args: string[];
  readonly callback: ExecCallback;
}

class FakeWatcher {
  readonly close = vi.fn(() => Promise.resolve());
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

let workDir: string;
let watchers: FakeWatcher[];
let pendingGit: PendingCall[];
let pendingGh: PendingCall[];

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-status-')));
  watchers = [];
  pendingGit = [];
  pendingGh = [];
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
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.clearAllMocks();
});

function writeRepo(dir: string, head = 'ref: refs/heads/main\n'): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), head);
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
  it('shows the branch on the first frame and fills in stats asynchronously', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();

    const cache = createGitStatusCache(workDir, { onChange });

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });
    expect(onChange).not.toHaveBeenCalled();
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

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(pendingGit).toHaveLength(0);

    cache.refresh();
    expect(pendingGit).toHaveLength(1);
    await answerGitRound('## main...origin/main\n M src/app.ts\n', '6\t2\tsrc/app.ts\n');
    expect(cache.getStatus()?.diffAdded).toBe(6);
    cache.dispose();
  });

  it('rereads the branch immediately on HEAD watcher events and debounces stats refreshes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(watchers).toHaveLength(1);
    expect(mocks.chokidarWatch).toHaveBeenCalledWith(
      join(workDir, '.git', 'HEAD'),
      expect.objectContaining({ usePolling: true, interval: 1000, ignoreInitial: true }),
    );

    writeFileSync(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
    onChange.mockClear();
    watchers[0]!.emit('change');

    expect(cache.getStatus()?.branch).toBe('feature');
    expect(onChange).toHaveBeenCalledTimes(1);

    watchers[0]!.emit('change');
    watchers[0]!.emit('change');
    vi.advanceTimersByTime(999);
    expect(pendingGit).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pendingGit).toHaveLength(1);

    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    writeFileSync(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/from-error-event\n');
    watchers[0]!.emit('error');
    expect(cache.getStatus()?.branch).toBe('from-error-event');
    cache.dispose();
  });

  it('shows the short sha for a detached HEAD', () => {
    writeRepo(workDir, `${'a'.repeat(40)}\n`);
    const cache = createGitStatusCache(workDir);
    expect(cache.getStatus()?.branch).toBe('aaaaaaa');
    cache.dispose();
  });

  it('resolves a relative gitdir pointer file with a BOM', () => {
    const gitDir = join(workDir, 'real-git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/worktree\n');
    const worktree = join(workDir, 'wt');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), '\uFEFFgitdir: ../real-git\n');

    const cache = createGitStatusCache(worktree);
    expect(cache.getStatus()?.branch).toBe('worktree');
    expect(mocks.chokidarWatch).toHaveBeenCalledWith(
      join(gitDir, 'HEAD'),
      expect.objectContaining({ usePolling: true }),
    );
    cache.dispose();
  });

  it('finds the repository by walking up from a nested directory', () => {
    writeRepo(workDir, 'ref: refs/heads/parent\n');
    const nested = join(workDir, 'sub', 'deep');
    mkdirSync(nested, { recursive: true });

    const cache = createGitStatusCache(nested);
    expect(cache.getStatus()?.branch).toBe('parent');
    cache.dispose();
  });

  it('returns null outside a repo without spawning or watching, and picks up git init within a TTL cycle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const cache = createGitStatusCache(workDir);

    expect(cache.getStatus()).toBeNull();
    expect(pendingGit).toHaveLength(0);
    expect(pendingGh).toHaveLength(0);
    expect(mocks.chokidarWatch).not.toHaveBeenCalled();

    writeRepo(workDir);
    vi.setSystemTime(new Date('2026-04-24T00:00:10Z'));
    expect(cache.getStatus()).toBeNull();

    vi.setSystemTime(new Date('2026-04-24T00:00:31Z'));
    expect(cache.getStatus()?.branch).toBe('main');
    expect(mocks.chokidarWatch).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('drops the badge when the repository disappears', async () => {
    writeRepo(workDir);
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });
    expect(cache.getStatus()).not.toBeNull();
    answerGh(new Error('no pull request'));
    await answerGitRound(new Error('never'));
    onChange.mockClear();

    rmSync(join(workDir, '.git', 'HEAD'));
    watchers[0]!.emit('unlink');

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
    expect(pendingGit).toHaveLength(1);
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(cache.getStatus()?.diffAdded).toBe(4);
    cache.dispose();
  });

  it('still shows the branch from HEAD when git cannot be resolved to a safe path', async () => {
    mocks.resolveCommandPath.mockReturnValue(undefined);
    writeRepo(workDir);
    const cache = createGitStatusCache(workDir);

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
    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound('## main...origin/main\n');

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', workDir);
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

  it('reads current pull request metadata and notifies on change', async () => {
    writeRepo(workDir, 'ref: refs/heads/feature/footer\n');
    const onChange = vi.fn();
    const cache = createGitStatusCache(workDir, { onChange });

    expect(cache.getStatus()?.pullRequest).toBeNull();
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

    expect(cache.getStatus()?.branch).toBe('main');
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

    cache.getStatus();
    expect(pendingGit).toHaveLength(1);
    onChange.mockClear();

    writeFileSync(join(workDir, '.git', 'HEAD'), 'garbage\n');
    watchers[0]!.emit('change');
    cache.dispose();
    expect(watchers[0]!.close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(pendingGit).toHaveLength(1);

    answerGh(new Error('no pull request'));
    await answerGitRound(STATUS_DIRTY, DIFF_DIRTY);
    expect(onChange).not.toHaveBeenCalled();
    expect(cache.getStatus()).toBeNull();
  });

  it('treats a .git directory without HEAD as a non-repo', () => {
    mkdirSync(join(workDir, '.git'), { recursive: true });
    const cache = createGitStatusCache(workDir);

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

    cache.getStatus();
    answerGh(new Error('no pull request'));
    await answerGitRound('## main...origin/main\n');
    onChange.mockClear();

    writeFileSync(join(workDir, '.git', 'HEAD'), 'garbage\n');
    watchers[0]!.emit('change');
    expect(cache.getStatus()?.branch).toBe('main');
    expect(onChange).not.toHaveBeenCalled();
    expect(watchers[0]!.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(cache.getStatus()?.branch).toBe('main');
    expect(onChange).not.toHaveBeenCalled();

    writeFileSync(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/recovered\n');
    watchers[0]!.emit('change');
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
