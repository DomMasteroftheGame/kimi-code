import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { declarationFingerprint, loadProjectEnvironmentsSection, resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { Emitter } from '#/_base/event';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { EnvironmentsSectionSchema, type EnvironmentsSection, type EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

function fakeConfig(section: EnvironmentsSection | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'environments' ? section : undefined),
  } as unknown as IConfigService;
}

const USER_TOML: EnvironmentsSection = EnvironmentsSectionSchema.parse({
  default: 'user-box',
  'user-box': { type: 'ssh', host: 'user-box', defaultCwd: '/home/me/user' },
  shared: { type: 'ssh', host: 'user-shared', defaultCwd: '/home/me/shared' },
});

describe('resolveWorkspaceEnvironmentDeclarations', () => {
  it('resolves user declarations from the [environments] section', async () => {
    const resolved = await resolveWorkspaceEnvironmentDeclarations(fakeConfig(USER_TOML));
    expect(resolved.entries.map((entry) => entry.id).toSorted()).toEqual(['shared', 'user-box']);
    expect(resolved.default).toEqual({ environmentId: 'user-box', cwd: '/home/me/user' });
  });

  it('yields no entries and no default without a section', async () => {
    const resolved = await resolveWorkspaceEnvironmentDeclarations(fakeConfig(undefined));
    expect(resolved.entries).toEqual([]);
    expect(resolved.default).toBeUndefined();
  });
});

beforeEach(() => vi.stubEnv('KIMI_CODE_WATCH', 'false'));
afterEach(() => vi.unstubAllEnvs());

function projectSource(text?: string, initiallyTrusted = false) {
  let content = text;
  let trusted = initiallyTrusted;
  const changes = new Emitter<{ trusted: boolean }>();
  const fs = {
    readText: vi.fn(async () => {
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    }),
  } as unknown as IHostFileSystem;
  const trust = {
    ready: Promise.resolve(), isTrusted: () => trusted, onDidChange: changes.event,
  } as unknown as IWorkspaceTrust;
  return {
    fs, trust,
    setText: (text?: string) => { content = text; },
    setTrusted: (value: boolean) => { trusted = value; changes.fire({ trusted }); },
  };
}

function context(id: string): IWorkspaceContext {
  return { workspaceId: id, cwd: `/${id}`, source: 'local' } as IWorkspaceContext;
}

const PROJECT = 'default = "dev"\n[dev]\ntype = "ssh"\nhost = "dev.example.test"\ndefaultCwd = "/remote/project"\n';

describe('project environment declarations', () => {
  it('reads a standalone section from the local root and rejects malformed or wrapped TOML', async () => {
    const source = projectSource(PROJECT);
    await expect(loadProjectEnvironmentsSection(source.fs, '/local')).resolves.toMatchObject({ default: 'dev' });
    expect(source.fs.readText).toHaveBeenCalledWith('/local/.kimi-code/environments.toml');
    source.setText('[environments.dev]\ntype = "ssh"\nhost = "dev.example.test"');
    await expect(loadProjectEnvironmentsSection(source.fs, '/local')).rejects.toMatchObject({ code: 'config.invalid' });
    source.setText('invalid = [');
    await expect(loadProjectEnvironmentsSection(source.fs, '/local')).rejects.toMatchObject({ code: 'config.invalid' });
    source.setText();
    await expect(loadProjectEnvironmentsSection(source.fs, '/missing')).resolves.toBeUndefined();
  });

  it('keeps untrusted declarations preview-only and requires trust for their default', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    expect((await service.catalog()).entries).toEqual([]);
    expect(await service.declarations('a')).toMatchObject({ entries: [], trustRequired: true });
    source.setTrusted(true);
    expect(await service.declarations('a')).toMatchObject({
      default: { environmentId: 'dev', cwd: '/remote/project', source: 'project' },
    });
    expect(service.isVisible('a', 'dev')).toBe(true);
    expect(service.isVisible('b', 'dev')).toBe(false);
    source.setTrusted(false);
    expect(service.isVisible('a', 'dev')).toBe(false);
    expect((await service.catalog()).entries).toEqual([]);
    attachment.dispose();
    service.dispose();
  });

  it('shares normalized launcher declarations but retains the user default cwd when a project has no default', async () => {
    const user = EnvironmentsSectionSchema.parse({ default: 'dev', dev: { type: 'ssh', host: 'dev.example.test', defaultCwd: '/remote/user' } });
    const service = new EnvironmentDeclarationService(fakeConfig(user), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT.replace('default = "dev"\n', ''), true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    expect((await service.catalog()).entries).toHaveLength(1);
    expect((await service.declarations('a'))?.default).toEqual({ environmentId: 'dev', cwd: '/remote/user' });
    expect((await service.declarations('a'))?.entries[0]).toMatchObject({ source: 'project', entry: { defaultCwd: '/remote/project' } });
    source.setTrusted(false);
    expect((await service.catalog()).entries).toHaveLength(1);
    expect(service.isVisible('b', 'dev')).toBe(true);
    expect(() => { service.assertAllowed('a', 'dev', true); }).toThrow('trusted declaration');
    attachment.dispose();
    service.dispose();
    expect(declarationFingerprint({ command: 'ssh' })).toBe(declarationFingerprint({ command: 'ssh', args: [], env: {} }));
  });

  it('rejects conflicting launchers with both origins and never lets the registered fallback select the other target', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig({ dev: { type: 'ssh', host: 'user.example.test' } } as EnvironmentsSection), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    const result = await service.declarations('a');
    expect(result?.projectError?.message).toContain('/a/.kimi-code/environments.toml');
    expect(result?.projectError?.message).toContain('config.toml');
    expect(() => { service.assertAllowed('a', 'dev'); }).toThrow('conflicts');
    expect(() => { service.assertAllowed('b', 'dev'); }).not.toThrow();
    source.setText(PROJECT.replace('dev.example.test', 'user.example.test'));
    await service.declarations('a');
    expect(() => { service.assertAllowed('a', 'dev'); }).not.toThrow();
    attachment.dispose();
    service.dispose();
  });

  it('fails closed on invalid trusted config or missing project provenance while preserving dynamic bindings', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    source.setText('broken = [');
    expect((await service.declarations('a'))?.projectError).toMatchObject({ code: 'config.invalid' });
    expect(() => { service.assertAllowed('a', 'dev', true); }).toThrow('Invalid environment declarations');
    expect(() => { service.assertAllowed('a', 'acp:example'); }).not.toThrow();
    source.setText();
    await service.declarations('a');
    expect(() => { service.assertAllowed('a', 'dev', true); }).toThrow('trusted declaration');
    attachment.dispose();
    service.dispose();
  });

  it('uses current registration ownership instead of reserving project ids forever', async () => {
    const registry = new EnvironmentRegistry();
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, registry);
    const source = projectSource('["acp:example"]\ncommand = "executor"', true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    const environment = new FakeEnvironment({ environmentId: 'acp:example', generation: 'declared' });
    const registration = registry.register(environment);
    const ownership = service.trackRegistration(environment);
    const lease = registry.acquire({ environmentId: 'acp:example' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    service.onDidChange((event) => { event.waitUntil(gate); });
    source.setText();
    const refresh = service.declarations('a');
    await vi.waitFor(() => {
      expect(() => { service.assertAllowed('a', 'acp:example'); }).toThrow('not authorized');
    });
    const removal = registration.remove();
    registry.register(new FakeEnvironment({ environmentId: 'acp:example', generation: 'dynamic' }));
    expect(() => { service.assertAllowed('a', 'acp:example'); }).not.toThrow();
    expect(() => { service.assertAllowed('a', 'acp:example', true); }).toThrow('trusted declaration');
    lease.dispose();
    await removal;
    ownership.dispose();
    release();
    await refresh;
    attachment.dispose();
    await service.declarations();
    expect(service.isVisible('a', 'acp:example')).toBe(true);
    service.dispose();
    await registry.dispose();
  });

  it('coalesces scoped reads, does not reload projects for tool acquires, and emits no unchanged catalog', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const first = projectSource(PROJECT, true);
    const second = projectSource('[other]\ncommand = "other"', true);
    const a = service.attachWorkspace(context('a'), first.fs, first.trust);
    const b = service.attachWorkspace(context('b'), second.fs, second.trust);
    await service.catalog();
    const changes = vi.fn();
    service.onDidChange(changes);
    vi.mocked(first.fs.readText).mockClear();
    vi.mocked(second.fs.readText).mockClear();
    await Promise.all([service.declarations('a'), service.declarations('a'), service.declarations('a')]);
    expect(first.fs.readText).toHaveBeenCalledTimes(1);
    expect(second.fs.readText).not.toHaveBeenCalled();
    await service.whenReady('a');
    await service.whenReady('a');
    expect(first.fs.readText).toHaveBeenCalledTimes(1);
    expect(changes).not.toHaveBeenCalled();
    first.setText(PROJECT.replace('dev.example.test', 'new.example.test'));
    await service.declarations('a');
    expect(changes).toHaveBeenCalledOnce();
    a.dispose();
    b.dispose();
    service.dispose();
  });

  it('reloads again when an invalidation arrives during a coalesced read', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    let release!: () => void;
    let start!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { start = resolve; });
    vi.mocked(source.fs.readText).mockImplementationOnce(async () => { start(); await gate; return PROJECT; });
    const refresh = service.declarations('a');
    await started;
    source.setText(PROJECT.replace('dev.example.test', 'new.example.test'));
    source.setTrusted(true);
    release();
    expect((await refresh)?.entries[0]?.entry).toMatchObject({ host: 'new.example.test' });
    await service.whenReady('a');
    expect(service.isVisible('a', 'dev')).toBe(true);
    attachment.dispose();
    service.dispose();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('does not lose an invalidation at singleflight settlement (microtask depth %s)', async (depth) => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    const changed: EnvironmentDeclarationSet[] = [];
    service.onDidChange((event) => { changed.push(event); });
    vi.mocked(source.fs.readText).mockImplementationOnce(async () => {
      const invalidate = (remaining: number): void => {
        queueMicrotask(() => {
          if (remaining > 1) invalidate(remaining - 1);
          else {
            source.setText(PROJECT.replace('dev.example.test', 'new.example.test'));
            source.setTrusted(true);
          }
        });
      };
      invalidate(depth);
      return PROJECT;
    });
    await service.declarations('a');
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    await service.whenReady('a');
    expect(changed.at(-1)?.entries[0]?.entry).toMatchObject({ host: 'new.example.test' });
    attachment.dispose();
    service.dispose();
  });

  it('does not let an unrelated slow project file block scoped declarations', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = projectSource(PROJECT, true);
    vi.mocked(slow.fs.readText).mockImplementation(async () => { await gate; return PROJECT; });
    const b = service.attachWorkspace(context('b'), slow.fs, slow.trust);
    const fast = projectSource('[fast]\ncommand = "fast"', true);
    const a = service.attachWorkspace(context('a'), fast.fs, fast.trust);
    let result: EnvironmentDeclarationSet | undefined;
    const ready = service.declarations('a').then((declarations) => { result = declarations; });
    await vi.waitFor(() => { expect(result).toMatchObject({ entries: [{ id: 'fast' }] }); });
    await ready;
    release();
    await service.catalog();
    a.dispose();
    b.dispose();
    service.dispose();
  });

  it('awaits provider reconciliation before returning a usable declaration', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    service.onDidChange((event) => { event.waitUntil(gate); });
    let settled = false;
    const pending = service.declarations().then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
    service.dispose();
  });

  it('preserves unreadable user-config fallback when an attached workspace has no project file', async () => {
    let failed = false;
    const config = { ready: Promise.resolve(), get: () => {
      if (failed) throw new Error('unreadable user config');
      return USER_TOML;
    } } as unknown as IConfigService;
    const service = new EnvironmentDeclarationService(config, { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(undefined, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    expect((await service.declarations('a'))?.default?.environmentId).toBe('user-box');
    failed = true;
    expect(await service.declarations('a')).toBeUndefined();
    expect(() => { service.assertAllowed('a', 'user-box'); }).not.toThrow();
    source.setText(PROJECT);
    expect(await service.declarations('a')).toMatchObject({
      default: { environmentId: 'dev', cwd: '/remote/project', source: 'project' },
      projectError: undefined,
    });
    source.setText(PROJECT.replace('default = "dev"\n', ''));
    expect((await service.declarations('a'))?.default).toBeUndefined();
    attachment.dispose();
    service.dispose();
  });

  it('clears failed registration state after the last declaration is removed', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    service.reportRegistration('dev', new Error('duplicate registration'));
    expect(() => { service.assertAllowed('a', 'dev'); }).toThrow('could not be registered');
    source.setText();
    await service.declarations('a');
    expect(() => { service.assertAllowed('a', 'dev'); }).not.toThrow();
    attachment.dispose();
    service.dispose();
  });
});
