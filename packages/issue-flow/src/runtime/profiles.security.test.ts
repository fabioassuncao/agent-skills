import { describe, expect, it } from 'vitest';
import { cloneProfile, parseProfileSecurity, parseRuntimeProfile } from './profiles.js';
import {
  buildDockerRunArgs,
  type SandboxProfileConfig,
  type SandboxSecurityConfig,
} from './sandbox/docker.js';

/**
 * The seam between the profile parser (phase 10) and the sandbox hardening
 * (phase 13).
 *
 * Phase 13 documented `security.sshAgent`, `security.network` and the rest as
 * configuration, but the parser dropped every key it did not know — so the
 * escape hatch was documented and unreachable, which is worse than absent: the
 * documentation says a thing works. These cases exist so that stops being
 * possible silently. They assert the whole path, from the raw `.issue-flow.json`
 * value to the argument docker is actually given.
 */
describe('sandbox hardening reaches the container', () => {
  function profileFrom(security: unknown) {
    return parseRuntimeProfile({ runtime: 'docker', image: 'if:test', security }, 'host');
  }

  function argsFor(security: SandboxSecurityConfig | undefined): string[] {
    const sandboxConfig: SandboxProfileConfig = {
      image: 'if:test',
      envPassthrough: [],
      ...(security === undefined ? {} : { security }),
    };
    return buildDockerRunArgs(
      {
        branch: 'my-branch',
        wtDir: '/repos/my-branch',
        mainRepoDir: '/repos/main',
        sandboxConfig,
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '3000' },
      },
      {
        existingPaths: new Set<string>(),
        home: '/home/u',
        name: 'if-test-123',
        hostUid: 501,
        hostGid: 20,
        hostEnv: {},
        hostTotalMemoryBytes: 8 * 1024 ** 3,
      },
    );
  }

  // The whole point: a value written in configuration has to change the flag.
  it('carries every field from configuration to the argument list', () => {
    const profile = profileFrom({
      network: 'none',
      pidsLimit: 512,
      memory: '2g',
      capAdd: ['NET_ADMIN'],
      noNewPrivileges: false,
      sshAgent: true,
      implicitMounts: false,
    });
    expect(profile.security).toEqual({
      network: 'none',
      pidsLimit: 512,
      memory: '2g',
      capAdd: ['NET_ADMIN'],
      noNewPrivileges: false,
      sshAgent: true,
      implicitMounts: false,
    });

    const args = argsFor(profile.security);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('512');
    expect(args[args.indexOf('--memory') + 1]).toBe('2g');
    expect(args[args.indexOf('--cap-add') + 1]).toBe('NET_ADMIN');
    expect(args).not.toContain('--security-opt');
  });

  // A profile that says nothing must still get the whole §14 posture, or the
  // escape hatch would have quietly become the default.
  it('leaves the hardened defaults in place when nothing is declared', () => {
    expect(profileFrom(undefined).security).toBeUndefined();

    const args = argsFor(undefined);
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges:true');
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(args.some((arg) => arg.startsWith('SSH_AUTH_SOCK'))).toBe(false);
  });

  describe('reading the declaration', () => {
    // The parser is tolerant everywhere else in this file, and a security key is
    // the one place where coercing a typo would turn hardening off.
    it('drops a value of the wrong type instead of coercing it', () => {
      expect(
        parseProfileSecurity({
          network: 'host',
          pidsLimit: 'many',
          memory: 42,
          capAdd: 'NET_ADMIN',
          noNewPrivileges: 'yes',
          sshAgent: 1,
        }),
      ).toBeUndefined();
    });

    it('reads a section that is not an object as absent', () => {
      expect(parseProfileSecurity('none')).toBeUndefined();
      expect(parseProfileSecurity(null)).toBeUndefined();
      expect(parseProfileSecurity([])).toBeUndefined();
    });

    // An empty object would read like a deliberate declaration downstream.
    it('is undefined rather than empty when nothing valid was declared', () => {
      expect(parseProfileSecurity({})).toBeUndefined();
      expect(parseProfileSecurity({ network: 'wat' })).toBeUndefined();
    });

    it('keeps the valid half of a partly wrong declaration', () => {
      expect(parseProfileSecurity({ network: 'none', pidsLimit: -1 })).toEqual({ network: 'none' });
    });

    it('accepts 0 for the two fields where it means "omit the flag"', () => {
      expect(parseProfileSecurity({ pidsLimit: 0, memory: '0' })).toEqual({
        pidsLimit: 0,
        memory: '0',
      });
    });

    it('keeps false, which is a decision rather than an absence', () => {
      expect(parseProfileSecurity({ noNewPrivileges: false, sshAgent: false })).toEqual({
        noNewPrivileges: false,
        sshAgent: false,
      });
    });
  });

  // `cloneProfile` exists because callers mutate what they are handed; a shared
  // `capAdd` array would let one caller's push become everybody's capability.
  it('hands out a copy of capAdd rather than the stored array', () => {
    const profile = profileFrom({ capAdd: ['NET_ADMIN'] });
    const copy = cloneProfile(profile);
    copy.security?.capAdd?.push('SYS_ADMIN');

    expect(profile.security?.capAdd).toEqual(['NET_ADMIN']);
  });
});
