// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${VAR}` is the placeholder syntax expandTemplate resolves; these are data, not template literals.
import { describe, expect, it } from 'vitest';
import {
  clonePanes,
  DEFAULT_PANES,
  type DockerRuntimeProfile,
  defaultProfiles,
  expandTemplate,
  getDefaultProfileName,
  isDockerProfile,
  mergeProfileLayers,
  parsePaneTemplate,
  parsePaneTemplates,
  parseProfilePermission,
  parseRuntimeProfile,
  parseRuntimeProfiles,
  type RuntimeProfile,
  resolveProfile,
  resolveProfileSystemPrompt,
} from './profiles.js';
import type { SandboxProfileConfig, SandboxServiceConfig } from './sandbox/index.js';
import type { ServiceSpec } from './services.js';

/**
 * Ported from WebMux `backend/src/__tests__/setup.test.ts` @ d8c9d5f — the
 * profile, pane and `expandTemplate` cases, which are the slice of that file
 * this module owns. The YAML of the original becomes the plain objects the
 * parser actually receives, because reading the file is `src/config/runtime.ts`'s
 * job and is tested there.
 */

describe('expandTemplate', () => {
  it('replaces known placeholders', () => {
    expect(expandTemplate('Hello ${NAME}', { NAME: 'world' })).toBe('Hello world');
  });

  it('leaves unknown placeholders as an empty string', () => {
    expect(expandTemplate('Hello ${MISSING}', {})).toBe('Hello ');
  });

  it('replaces multiple placeholders in one string', () => {
    expect(expandTemplate('${A}-${B}', { A: 'foo', B: 'bar' })).toBe('foo-bar');
  });

  it('returns the string unchanged when there are no placeholders', () => {
    expect(expandTemplate('no placeholders', {})).toBe('no placeholders');
  });
});

describe('parsePaneTemplate', () => {
  it('keeps split, size, focus and cwd', () => {
    expect(
      parsePaneTemplate(
        { id: 'shell', kind: 'shell', split: 'bottom', sizePct: 30, focus: true, cwd: 'repo' },
        0,
      ),
    ).toEqual({
      id: 'shell',
      kind: 'shell',
      split: 'bottom',
      sizePct: 30,
      focus: true,
      cwd: 'repo',
    });
  });

  it('names an unnamed pane after its position', () => {
    expect(parsePaneTemplate({ kind: 'agent' }, 2)).toEqual({ id: 'pane-3', kind: 'agent' });
  });

  it('drops a pane with an unknown kind', () => {
    expect(parsePaneTemplate({ id: 'x', kind: 'browser' }, 0)).toBeNull();
    expect(parsePaneTemplate('agent', 0)).toBeNull();
  });

  // A command pane with no command would silently open a plain shell where a
  // service was expected — worse than a pane that is visibly missing.
  it('drops a command pane with no command', () => {
    expect(parsePaneTemplate({ id: 'app', kind: 'command' }, 0)).toBeNull();
    expect(parsePaneTemplate({ id: 'app', kind: 'command', command: '   ' }, 0)).toBeNull();
  });

  it('preserves command pane workingDir values from config', () => {
    expect(
      parsePaneTemplate(
        { id: 'app', kind: 'command', cwd: 'repo', workingDir: 'frontend', command: 'npm run dev' },
        0,
      ),
    ).toEqual({
      id: 'app',
      kind: 'command',
      cwd: 'repo',
      workingDir: 'frontend',
      command: 'npm run dev',
    });
  });

  it('ignores a non-finite sizePct and a non-boolean focus', () => {
    expect(
      parsePaneTemplate({ id: 'a', kind: 'shell', sizePct: Number.NaN, focus: 'yes' }, 0),
    ).toEqual({ id: 'a', kind: 'shell' });
  });
});

describe('parsePaneTemplates', () => {
  it('falls back to the default window when the list is absent', () => {
    expect(parsePaneTemplates(undefined)).toEqual(clonePanes(DEFAULT_PANES));
  });

  it('falls back to the default window when every entry is unusable', () => {
    expect(parsePaneTemplates([{ kind: 'nope' }, 42])).toEqual(clonePanes(DEFAULT_PANES));
  });

  it('keeps the usable entries when only some are unusable', () => {
    expect(parsePaneTemplates([{ id: 'agent', kind: 'agent' }, { kind: 'command' }])).toEqual([
      { id: 'agent', kind: 'agent' },
    ]);
  });
});

describe('parseProfilePermission', () => {
  it('maps yolo: true to autonomous', () => {
    expect(parseProfilePermission({ yolo: true })).toBe('autonomous');
  });

  // The upstream's own test asserts that `yolo: false` leaves no `yolo` behind;
  // here that means the phase's permission is left alone, not narrowed.
  it('maps yolo: false to no override at all', () => {
    expect(parseProfilePermission({ yolo: false })).toBeUndefined();
    expect(parseProfilePermission({})).toBeUndefined();
  });

  it('prefers the semantic permission over yolo', () => {
    expect(parseProfilePermission({ permission: 'read-only', yolo: true })).toBe('read-only');
  });

  it('ignores an unknown permission value', () => {
    expect(parseProfilePermission({ permission: 'god-mode' })).toBeUndefined();
  });
});

describe('parseRuntimeProfile', () => {
  it('reads the full profile shape', () => {
    expect(
      parseRuntimeProfile(
        {
          runtime: 'host',
          yolo: true,
          envPassthrough: ['GITHUB_TOKEN'],
          systemPrompt: 'be terse',
          panes: [{ id: 'agent', kind: 'agent', focus: true }],
        },
        'host',
      ),
    ).toEqual({
      runtime: 'host',
      envPassthrough: ['GITHUB_TOKEN'],
      permission: 'autonomous',
      systemPrompt: 'be terse',
      panes: [{ id: 'agent', kind: 'agent', focus: true }],
    });
  });

  it('reads mounts and the image of a docker profile', () => {
    const profile = parseRuntimeProfile(
      {
        runtime: 'docker',
        image: '  issue-flow-sandbox  ',
        mounts: [
          { hostPath: '/data', guestPath: '/mnt/data', writable: true },
          { guestPath: '/nowhere' },
        ],
      },
      'host',
    );

    expect(profile.image).toBe('issue-flow-sandbox');
    expect(profile.mounts).toEqual([{ hostPath: '/data', guestPath: '/mnt/data', writable: true }]);
  });

  it('falls back to the default window and an empty passthrough', () => {
    expect(parseRuntimeProfile('nonsense', 'host')).toEqual({
      runtime: 'host',
      envPassthrough: [],
      panes: clonePanes(DEFAULT_PANES),
    });
  });

  it('ignores an envPassthrough that is not a list of strings', () => {
    expect(parseRuntimeProfile({ envPassthrough: ['A', 3] }, 'host').envPassthrough).toEqual([]);
  });
});

describe('parseRuntimeProfiles', () => {
  it('gives a profile named sandbox the docker runtime without being told', () => {
    const profiles = parseRuntimeProfiles({ sandbox: { image: 'img' } }, false);
    expect(profiles.sandbox?.runtime).toBe('docker');
  });

  it('leaves any other profile on the host by default', () => {
    const profiles = parseRuntimeProfiles({ slim: {} }, false);
    expect(profiles.slim?.runtime).toBe('host');
  });

  it('returns the built-in default only when asked to include it', () => {
    expect(Object.keys(parseRuntimeProfiles(undefined, true))).toEqual(['default']);
    expect(parseRuntimeProfiles(undefined, false)).toEqual({});
  });
});

describe('getDefaultProfileName', () => {
  it('prefers a profile named default', () => {
    expect(getDefaultProfileName({ slim: stub(), default: stub() })).toBe('default');
  });

  it('uses the first configured profile when no default profile exists', () => {
    expect(getDefaultProfileName({ slim: stub(), full: stub() })).toBe('slim');
  });

  it('answers with the built-in name for an empty map', () => {
    expect(getDefaultProfileName({})).toBe('default');
  });
});

describe('mergeProfileLayers', () => {
  it('replaces a profile of the same name whole, rather than merging its keys', () => {
    const merged = mergeProfileLayers(
      {
        shared: {
          runtime: 'host',
          envPassthrough: ['GITHUB_TOKEN'],
          panes: clonePanes(DEFAULT_PANES),
        },
      },
      {
        shared: {
          runtime: 'docker',
          image: 'local-sandbox',
          envPassthrough: [],
          panes: clonePanes(DEFAULT_PANES),
        },
      },
    );

    expect(merged.shared?.runtime).toBe('docker');
    expect(merged.shared?.image).toBe('local-sandbox');
    expect(merged.shared?.envPassthrough).toEqual([]);
  });

  it('keeps profiles only the lower layer declares', () => {
    const merged = mergeProfileLayers({ default: stub() }, { local: stub() });
    expect(Object.keys(merged).sort()).toEqual(['default', 'local']);
  });
});

// The upstream has this exact test: mutating what one load handed back must not
// be visible in the next one.
describe('defensive copies', () => {
  it('never hands out the shared default profile', () => {
    const first = defaultProfiles();
    first.default?.envPassthrough.push('MUTATED');
    first.default?.panes.push({ id: 'extra', kind: 'shell' });

    expect(defaultProfiles().default?.envPassthrough).toEqual([]);
    expect(defaultProfiles().default?.panes).toEqual(clonePanes(DEFAULT_PANES));
  });

  it('never hands out the stored profile from resolveProfile', () => {
    const profiles = defaultProfiles();
    resolveProfile(profiles, 'default').profile.envPassthrough.push('MUTATED');
    expect(profiles.default?.envPassthrough).toEqual([]);
  });

  it('never hands out the stored profile from mergeProfileLayers', () => {
    const source = defaultProfiles();
    mergeProfileLayers(source).default?.panes.push({ id: 'extra', kind: 'shell' });
    expect(source.default?.panes).toEqual(clonePanes(DEFAULT_PANES));
  });
});

describe('resolveProfile', () => {
  it('returns the named profile', () => {
    const profiles = { sandbox: stub('docker') };
    expect(resolveProfile(profiles, 'sandbox').name).toBe('sandbox');
  });

  it('warns and falls back for a name nobody declared', () => {
    const warnings: string[] = [];
    const resolved = resolveProfile(defaultProfiles(), 'sandox', (message) =>
      warnings.push(message),
    );

    expect(resolved.name).toBe('default');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('sandox');
  });

  it('falls back without warning when no name was asked for', () => {
    const warnings: string[] = [];
    expect(resolveProfile(defaultProfiles(), undefined, (m) => warnings.push(m)).name).toBe(
      'default',
    );
    expect(warnings).toEqual([]);
  });

  it('still answers with a launchable profile for an empty map', () => {
    expect(resolveProfile({}, undefined).profile.panes).toEqual(clonePanes(DEFAULT_PANES));
  });
});

describe('isDockerProfile', () => {
  it('requires both the runtime and a non-empty image', () => {
    expect(
      isDockerProfile({ runtime: 'docker', image: 'img', envPassthrough: [], panes: [] }),
    ).toBe(true);
    expect(isDockerProfile({ runtime: 'docker', image: '', envPassthrough: [], panes: [] })).toBe(
      false,
    );
    expect(isDockerProfile({ runtime: 'docker', envPassthrough: [], panes: [] })).toBe(false);
    expect(isDockerProfile({ runtime: 'host', image: 'img', envPassthrough: [], panes: [] })).toBe(
      false,
    );
    expect(isDockerProfile(undefined)).toBe(false);
  });
});

describe('resolveProfileSystemPrompt', () => {
  it('expands the runtime env into the prompt', () => {
    const profile: RuntimeProfile = {
      runtime: 'host',
      envPassthrough: [],
      panes: [],
      systemPrompt: 'The app runs on ${PORT}',
    };
    expect(resolveProfileSystemPrompt(profile, { PORT: '3020' })).toBe('The app runs on 3020');
  });

  it('is absent when the profile declares none', () => {
    expect(resolveProfileSystemPrompt(stub(), {})).toBeUndefined();
  });
});

// Phase 12 wrote the sandbox before profiles existed, so it declared structural
// subsets of these shapes and recorded that "phase 10's richer type only has to
// stay assignable to it". This is that contract, checked by the compiler: if the
// two drift apart, the sandbox quietly stops receiving what a profile declares.
describe('the shapes phase 12 declared subsets of', () => {
  it('stays assignable to SandboxProfileConfig and SandboxServiceConfig', () => {
    const profile: DockerRuntimeProfile = {
      runtime: 'docker',
      image: 'issue-flow-sandbox',
      permission: 'autonomous',
      envPassthrough: ['GITHUB_TOKEN'],
      mounts: [{ hostPath: '/data', guestPath: '/mnt/data', writable: true }],
      panes: clonePanes(DEFAULT_PANES),
    };
    const asSandboxProfile: SandboxProfileConfig = profile;
    expect(asSandboxProfile.image).toBe('issue-flow-sandbox');

    const service: ServiceSpec = { name: 'frontend', portEnv: 'FRONTEND_PORT', portStart: 3000 };
    const asSandboxService: SandboxServiceConfig = service;
    expect(asSandboxService.portEnv).toBe('FRONTEND_PORT');
  });
});

function stub(runtime: 'host' | 'docker' = 'host'): RuntimeProfile {
  return { runtime, envPassthrough: [], panes: clonePanes(DEFAULT_PANES) };
}
