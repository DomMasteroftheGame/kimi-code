import { describe, expect, it, vi } from 'vitest';

import type { IEnvironmentService } from '#/app/environment/environment';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

import { fakeEnvironment } from '../../environment/stubs';

function closeHarness(environments: EnvironmentRegistry): SessionLifecycleService {
  return new SessionLifecycleService(
    undefined as never,
    { workspaceId: 'workspace' } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { drain: async () => {} } as never,
    { drainRetirements: async () => {} } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { publish: () => {} } as never,
    { withContext: () => ({ track2: () => {} }) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    environments as unknown as IEnvironmentService,
  );
}

function seedSession(service: SessionLifecycleService, sessionId: string): void {
  const handle = {
    id: sessionId,
    kind: 'session',
    accessor: {
      get: () => ({ list: () => [], setArchived: async () => {} }),
    },
    dispose: () => {},
  } as unknown as ISessionScopeHandle;
  (service as unknown as { sessions: Map<string, ISessionScopeHandle> }).sessions.set(sessionId, handle);
}

describe('SessionLifecycleService environment cleanup', () => {
  it('close drains only the closing session environment resources', async () => {
    const registry = new EnvironmentRegistry();
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ environmentId: 'local' });
    const leaseB = registry.acquire({ environmentId: 'local' });
    const killed: string[] = [];
    leaseA.track({ dispose: () => { killed.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { killed.push('b'); } }, 'session-b');

    const service = closeHarness(registry);
    seedSession(service, 'session-a');
    await service.close('session-a');

    expect(killed).toEqual(['a']);
    leaseA.dispose();
    leaseB.dispose();
  });

  it('archive drains the archived session environment resources', async () => {
    const registry = new EnvironmentRegistry();
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ environmentId: 'local' });
    const leaseB = registry.acquire({ environmentId: 'local' });
    const killed: string[] = [];
    leaseA.track({ dispose: () => { killed.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { killed.push('b'); } }, 'session-b');

    const service = closeHarness(registry);
    seedSession(service, 'session-a');
    await service.archive('session-a');

    expect(killed).toEqual(['a']);
    leaseA.dispose();
    leaseB.dispose();
  });

  it('close without a live session leaves environment resources untouched', async () => {
    const registry = new EnvironmentRegistry();
    registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ environmentId: 'local' });
    const killed: string[] = [];
    lease.track({ dispose: () => { killed.push('a'); } }, 'session-a');

    const service = closeHarness(registry);
    await service.close('session-a');

    expect(killed).toEqual([]);
    lease.dispose();
  });
});

function createMaterializeHarness() {
  const stop = new Error('stop');
  const mergeAdditionalDirs = vi.fn(async () => {
    throw stop;
  });
  const workspaceDirs = {
    ready: Promise.resolve(),
    mergeAdditionalDirs,
    sessionInfo: () => ({}),
  };
  const args = [
    undefined,
    { workspaceId: 'workspace', persistenceScope: 'sessions/workspace' },
    { homeDir: '/tmp' },
    { ready: Promise.resolve(), get: () => false },
    undefined,
    undefined,
    { append: () => {}, flush: async () => {} },
    undefined,
    undefined,
    undefined,
    undefined,
    { publish: () => {} },
    { withContext: () => ({ track2: () => {} }) },
    { exposedIds: () => [] },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    workspaceDirs,
    { reloadSources: async () => {}, sessionData: () => ({}) },
    { sessionProvider: () => ({}) },
    { sessionHandle: () => ({}) },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    new EnvironmentRegistry(),
  ];
  const service = Reflect.construct(SessionLifecycleService, args) as SessionLifecycleService;
  return { service, mergeAdditionalDirs, stop };
}

describe('SessionLifecycleService environment-aware directories', () => {
  it('resolves additional directories from the bound environment cwd', async () => {
    const { service, mergeAdditionalDirs, stop } = createMaterializeHarness();
    await expect(service.create({
      workDir: '/workspace',
      environmentId: 'remote',
      environmentCwd: '/remote/work',
      additionalDirs: ['../shared'],
    })).rejects.toBe(stop);

    expect(mergeAdditionalDirs).toHaveBeenCalledWith('/remote/work', ['../shared']);
  });
});
