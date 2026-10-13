import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { watch, type FSWatcher } from 'chokidar';

import { resolveCommandPath } from '#/utils/process/resolve-command';

const STATUS_TTL_MS = 30_000;
const HEAD_POLL_INTERVAL_MS = 1_000;
const STATS_REFRESH_DEBOUNCE_MS = 1_000;
const PULL_REQUEST_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 500;
const PR_SPAWN_TIMEOUT_MS = 5_000;

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  readonly pullRequest: PullRequestInfo | null;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
}

export interface GitStatusCache {
  getStatus(): GitStatus | null;
  refresh(): void;
  dispose(): void;
}

export interface GitStatusCacheOptions {
  readonly onChange?: () => void;
}

interface StatsState {
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
  fetchedAt: number;
}

interface RepoState {
  readonly headPath: string;
  branch: string;
}

interface PullRequestState {
  value: PullRequestInfo | null;
  branch: string | null;
  fetchedAt: number;
  pendingBranch: string | null;
  requestId: number;
}

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/;
const HEAD_REF_PREFIX = 'ref: refs/heads/';
const DETACHED_HEAD_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function createGitStatusCache(
  workDir: string,
  options: GitStatusCacheOptions = {},
): GitStatusCache {
  const git = resolveCommandPath('git', workDir);
  let gh = resolveCommandPath('gh', workDir);
  let repo: RepoState | null = null;
  let watcher: FSWatcher | null = null;
  let probeInFlight = false;
  let nonRepoProbedAt = 0;
  let stats: StatsState = {
    dirty: false,
    ahead: 0,
    behind: 0,
    diffAdded: 0,
    diffDeleted: 0,
    fetchedAt: 0,
  };
  let pullRequest: PullRequestState = {
    value: null,
    branch: null,
    fetchedAt: 0,
    pendingBranch: null,
    requestId: 0,
  };
  let statsRefreshRunning = false;
  let statsRefreshPending = false;
  let statsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let branchRereadRunning = false;
  let branchRereadPending = false;
  let branchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  requestProbe();

  return {
    getStatus: () => {
      if (disposed) return null;
      const now = Date.now();
      if (repo === null) {
        if (now - nonRepoProbedAt >= STATUS_TTL_MS) requestProbe();
        return null;
      }
      if (now - stats.fetchedAt >= STATUS_TTL_MS) requestStatsRefresh();
      refreshPullRequestIfNeeded(repo.branch, now);
      return {
        branch: repo.branch,
        dirty: stats.dirty,
        ahead: stats.ahead,
        behind: stats.behind,
        diffAdded: stats.diffAdded,
        diffDeleted: stats.diffDeleted,
        pullRequest: pullRequest.branch === repo.branch ? pullRequest.value : null,
      };
    },
    refresh: () => {
      requestStatsRefresh();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (statsDebounceTimer !== null) {
        clearTimeout(statsDebounceTimer);
        statsDebounceTimer = null;
      }
      if (branchRetryTimer !== null) {
        clearTimeout(branchRetryTimer);
        branchRetryTimer = null;
      }
      closeWatcher();
    },
  };

  function requestProbe(): void {
    if (disposed || repo !== null || probeInFlight) return;
    probeInFlight = true;
    nonRepoProbedAt = Date.now();
    void runProbe();
  }

  async function runProbe(): Promise<void> {
    try {
      const found = await findRepo(workDir);
      if (disposed || repo !== null || found === null) return;
      repo = { headPath: found.headPath, branch: found.branch };
      stats = { dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0, fetchedAt: 0 };
      startWatcher(found.headPath);
      options.onChange?.();
    } finally {
      probeInFlight = false;
    }
  }

  function startWatcher(headPath: string): void {
    try {
      watcher = watch(headPath, {
        usePolling: true,
        interval: HEAD_POLL_INTERVAL_MS,
        ignoreInitial: true,
        persistent: false,
      });
      watcher.on('change', onHeadEvent);
      watcher.on('unlink', onHeadEvent);
      watcher.on('error', onHeadEvent);
      watcher.once('ready', onHeadEvent);
    } catch {
      watcher = null;
    }
  }

  function becomeNonRepo(): void {
    repo = null;
    nonRepoProbedAt = Date.now();
    closeWatcher();
  }

  function closeWatcher(): void {
    const current = watcher;
    watcher = null;
    if (current !== null) void current.close().catch(() => undefined);
  }

  function onHeadEvent(): void {
    requestBranchReread(false);
  }

  function requestBranchReread(fromRetry: boolean): void {
    if (disposed || repo === null) return;
    if (branchRereadRunning) {
      branchRereadPending = true;
      return;
    }
    branchRereadRunning = true;
    void runBranchReread(fromRetry);
  }

  async function runBranchReread(fromRetry: boolean): Promise<void> {
    try {
      const current = repo;
      if (current === null) return;
      const branch = await readHeadBranch(current.headPath);
      if (disposed || repo === null) return;
      if (branch === null) {
        if (await pathMissing(current.headPath)) {
          if (disposed || repo === null) return;
          becomeNonRepo();
          options.onChange?.();
        } else if (!fromRetry) {
          scheduleBranchRetry();
        }
        return;
      }
      if (branch !== repo.branch) {
        repo.branch = branch;
        options.onChange?.();
      }
      scheduleStatsRefresh();
    } finally {
      branchRereadRunning = false;
      if (branchRereadPending && !disposed) {
        branchRereadPending = false;
        requestBranchReread(false);
      }
    }
  }

  function scheduleBranchRetry(): void {
    if (branchRetryTimer !== null) return;
    branchRetryTimer = setTimeout(() => {
      branchRetryTimer = null;
      requestBranchReread(true);
    }, HEAD_POLL_INTERVAL_MS);
    branchRetryTimer.unref?.();
  }

  function scheduleStatsRefresh(): void {
    if (statsDebounceTimer !== null) clearTimeout(statsDebounceTimer);
    statsDebounceTimer = setTimeout(() => {
      statsDebounceTimer = null;
      requestStatsRefresh();
    }, STATS_REFRESH_DEBOUNCE_MS);
    statsDebounceTimer.unref?.();
  }

  function requestStatsRefresh(): void {
    if (disposed || repo === null || git === undefined) return;
    if (statsRefreshRunning) {
      statsRefreshPending = true;
      return;
    }
    statsRefreshRunning = true;
    stats = { ...stats, fetchedAt: Date.now() };
    void Promise.resolve().then(() => runStatsRefresh(git));
  }

  async function runStatsRefresh(resolvedGit: string): Promise<void> {
    try {
      const next = await readStats(resolvedGit, workDir);
      if (!disposed && repo !== null && next !== null && !sameStats(stats, next)) {
        stats = { ...next, fetchedAt: Date.now() };
        options.onChange?.();
      }
    } finally {
      statsRefreshRunning = false;
      if (statsRefreshPending && !disposed) {
        statsRefreshPending = false;
        requestStatsRefresh();
      }
    }
  }

  function refreshPullRequestIfNeeded(branchName: string, now: number): void {
    if (pullRequest.pendingBranch === branchName) return;
    const fetchedAt = pullRequest.branch === branchName ? pullRequest.fetchedAt : 0;
    if (now - fetchedAt < PULL_REQUEST_TTL_MS) return;

    const requestId = pullRequest.requestId + 1;
    pullRequest = {
      value: pullRequest.branch === branchName ? pullRequest.value : null,
      branch: branchName,
      fetchedAt,
      pendingBranch: branchName,
      requestId,
    };

    void Promise.resolve()
      .then(() => {
        if (gh === undefined) gh = resolveCommandPath('gh', workDir);
        return readPullRequest(gh, workDir);
      })
      .then((value) => {
      if (disposed || pullRequest.requestId !== requestId) return;

      const previous = pullRequest.branch === branchName ? pullRequest.value : null;
      const changed = !samePullRequest(previous, value);
      pullRequest = {
        value,
        branch: branchName,
        fetchedAt: Date.now(),
        pendingBranch: null,
        requestId,
      };
      if (changed) options.onChange?.();
    });
  }
}

interface RepoLocation {
  readonly headPath: string;
  readonly branch: string;
}

async function findRepo(workDir: string): Promise<RepoLocation | null> {
  const envGitDir = process.env['GIT_DIR'];
  if (envGitDir !== undefined && envGitDir.trim().length > 0) {
    const gitDir = isAbsolute(envGitDir) ? envGitDir : resolve(workDir, envGitDir);
    const headPath = join(gitDir, 'HEAD');
    const branch = await readHeadBranch(headPath);
    return branch === null ? null : { headPath, branch };
  }

  const ceilings = ceilingDirectories();
  const crossFilesystem = discoveryAcrossFilesystem();
  let dir = await physicalDir(workDir);
  let device = (await tryStat(dir))?.dev;
  for (;;) {
    const dotGit = join(dir, '.git');
    const dotGitStat = await tryStat(dotGit);
    if (dotGitStat !== null) {
      const gitDir = dotGitStat.isDirectory()
        ? dotGit
        : dotGitStat.isFile()
          ? await readGitdirPointer(dotGit, dir)
          : null;
      if (gitDir === null) return null;
      const headPath = join(gitDir, 'HEAD');
      const branch = await readHeadBranch(headPath);
      return branch === null ? null : { headPath, branch };
    }
    if (ceilings.has(normalizeForComparison(dir))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (!crossFilesystem) {
      const parentDevice = (await tryStat(parent))?.dev;
      if (device !== undefined && parentDevice !== undefined && parentDevice !== device) {
        return null;
      }
      device = parentDevice ?? device;
    }
    dir = parent;
  }
}

function discoveryAcrossFilesystem(): boolean {
  const raw = process.env['GIT_DISCOVERY_ACROSS_FILESYSTEM']?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function ceilingDirectories(): ReadonlySet<string> {
  const raw = process.env['GIT_CEILING_DIRECTORIES'];
  if (raw === undefined) return new Set();
  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = raw
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
  return new Set(entries.map(normalizeForComparison));
}

function normalizeForComparison(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function physicalDir(workDir: string): Promise<string> {
  try {
    return await realpath(workDir);
  } catch {
    return resolve(workDir);
  }
}

async function tryStat(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

async function readGitdirPointer(dotGit: string, dir: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(dotGit, 'utf8');
  } catch {
    return null;
  }
  const text = content.replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('gitdir:')) return null;
  const target = text.slice('gitdir:'.length).trim();
  if (target.length === 0) return null;
  return isAbsolute(target) ? target : resolve(dir, target);
}

async function readHeadBranch(headPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(headPath, 'utf8');
  } catch {
    return null;
  }
  const text = content.replace(/^\uFEFF/, '').trim();
  if (text.startsWith(HEAD_REF_PREFIX)) {
    const name = text.slice(HEAD_REF_PREFIX.length).trim();
    return name.length > 0 ? name : null;
  }
  if (DETACHED_HEAD_RE.test(text)) return text.slice(0, 7);
  return null;
}

interface StatsData {
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
}

async function readStats(git: string, workDir: string): Promise<StatsData | null> {
  const statusOut = await execGit(git, [
    '--no-optional-locks',
    '-C',
    workDir,
    'status',
    '--porcelain',
    '-b',
  ]);
  if (statusOut === null) return null;

  let dirty = false;
  let ahead = 0;
  let behind = 0;
  for (const line of statusOut.split('\n')) {
    if (line.startsWith('## ')) {
      const m = AHEAD_BEHIND_RE.exec(line);
      if (m) {
        ahead = Number.parseInt(m[1] ?? '0', 10) || 0;
        behind = Number.parseInt(m[2] ?? '0', 10) || 0;
      }
    } else if (line.trim().length > 0) {
      dirty = true;
    }
  }

  let diffAdded = 0;
  let diffDeleted = 0;
  if (dirty) {
    const diffOut = await execGit(git, [
      '--no-optional-locks',
      '-C',
      workDir,
      'diff',
      '--numstat',
      'HEAD',
      '--',
    ]);
    if (diffOut !== null) {
      for (const line of diffOut.split('\n')) {
        if (!line) continue;
        const [addedText, deletedText] = line.split('\t');
        diffAdded += parseDiffNumstatCount(addedText);
        diffDeleted += parseDiffNumstatCount(deletedText);
      }
    }
  }
  return { dirty, ahead, behind, diffAdded, diffDeleted };
}

function execGit(git: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        git,
        args,
        { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          resolvePromise(error === null ? stdout : null);
        },
      );
    } catch {
      resolvePromise(null);
    }
  });
}

function sameStats(a: StatsData, b: StatsData): boolean {
  return (
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.diffAdded === b.diffAdded &&
    a.diffDeleted === b.diffDeleted
  );
}

function parseDiffNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readPullRequest(gh: string | undefined, workDir: string): Promise<PullRequestInfo | null> {
  return new Promise((resolvePromise) => {
    if (gh === undefined) {
      resolvePromise(null);
      return;
    }
    try {
      execFile(
        gh,
        ['pr', 'view', '--json', 'number,url'],
        {
          cwd: workDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_PROMPT_DISABLED: '1',
          },
          timeout: PR_SPAWN_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
        },
        (error, stdout) => {
          if (error !== null) {
            resolvePromise(null);
            return;
          }
          resolvePromise(parsePullRequest(stdout));
        },
      );
    } catch {
      resolvePromise(null);
    }
  });
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.url === b.url;
}

function parsePullRequest(stdout: string): PullRequestInfo | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const number = record['number'];
    const url = record['url'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
    if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
    return { number, url };
  } catch {
    return null;
  }
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface FormatGitBadgeOptions {
  readonly linkPullRequest?: boolean;
}

export function formatGitBadgeBase(status: GitStatus): string {
  const parts: string[] = [];
  const diff = formatDiffStats(status);
  if (diff) parts.push(diff);
  let sync = '';
  if (status.ahead > 0) sync += `↑${status.ahead}`;
  if (status.behind > 0) sync += `↓${status.behind}`;
  if (sync) parts.push(sync);
  return parts.length === 0 ? status.branch : `${status.branch} [${parts.join(' ')}]`;
}

export function formatPullRequestBadge(
  pullRequest: PullRequestInfo,
  options: FormatGitBadgeOptions = {},
): string {
  const prText = `[PR#${String(pullRequest.number)}]`;
  return options.linkPullRequest ? toTerminalHyperlink(prText, pullRequest.url) : prText;
}

export function formatGitBadge(status: GitStatus, options: FormatGitBadgeOptions = {}): string {
  const base = formatGitBadgeBase(status);
  if (status.pullRequest === null) return base;

  return `${base} ${formatPullRequestBadge(status.pullRequest, options)}`;
}

function formatDiffStats(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.diffAdded > 0) parts.push(`+${String(status.diffAdded)}`);
  if (status.diffDeleted > 0) parts.push(`-${String(status.diffDeleted)}`);
  if (parts.length > 0) return parts.join(' ');
  return status.dirty ? '±' : null;
}

function toTerminalHyperlink(text: string, url: string): string {
  if (!isSafeHttpUrl(url)) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
