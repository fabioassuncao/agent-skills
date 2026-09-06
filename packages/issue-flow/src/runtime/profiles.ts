import type { AgentPermission } from '../agents/types.js';
import type { PaneKind, PaneTemplate } from './tmux/layout.js';

/**
 * Profiles — the named descriptions of *how* a worktree is opened.
 *
 * Adapted from WebMux `backend/src/adapters/config.ts` and
 * `backend/src/domain/config.ts` @ d8c9d5f (§16 of the absorption plan). A
 * profile answers three questions and nothing else: which runtime the worktree
 * gets (`host` or `docker`), what the window looks like (`panes`), and what the
 * agent inside it is allowed to do.
 *
 * Three things carry over exactly and are the reason this file is a port rather
 * than a rewrite:
 *
 * - **Nothing here throws.** Every parser is tolerant: an unusable pane is
 *   dropped, an unusable profile falls back to the defaults, and a section that
 *   is not an object is read as absent. A configuration typo must cost a
 *   warning, never the run — which is also the rule `src/config/` already
 *   follows for every other section.
 * - **Every read returns a fresh copy.** `cloneProfile` exists because callers
 *   mutate what they are handed (the upstream has a test for exactly that:
 *   pushing onto `envPassthrough` of one load must not be visible in the next).
 *   Handing out the shared default object turns one caller's mutation into
 *   everybody's configuration.
 * - **A profile named `sandbox` defaults to `runtime: docker`.** It is the
 *   whole reason the name is special-cased upstream, and dropping it would make
 *   the most common sandbox declaration silently run on the host.
 *
 * The one deliberate divergence is permission. The upstream has `yolo: boolean`;
 * Issue Flow has three semantic levels, and §45.3 lists a boolean as the
 * degraded form this port must not reintroduce. So `yolo` is **translated on
 * read** into `permission: 'autonomous'` and never stored as a second axis
 * (§16). A profile that declares neither leaves the phase's own permission
 * intact — a profile describes a window, it does not get to widen what an agent
 * may do behind the phase's back.
 *
 * `PaneTemplate` and `PaneKind` are not redefined here: they belong to
 * `tmux/layout.ts`, which is what consumes them, and this module re-exports them
 * so a caller working with profiles never has to reach into the tmux package.
 */

export type { PaneKind, PaneTemplate };

/** Where an agent of this profile runs. */
export type ProfileRuntimeKind = 'host' | 'docker';

/** One extra bind mount a docker profile asks for. */
export interface MountSpec {
  hostPath: string;
  guestPath?: string;
  writable?: boolean;
}

/**
 * The sandbox hardening a docker profile may soften.
 *
 * Every field is optional and every default is the hardened one, so a profile
 * that declares nothing gets the whole §14 posture. This exists to be the
 * *escape hatch*: a repository whose build genuinely needs a capability, a
 * network mode or the SSH agent says so here, once, in the open.
 *
 * The shape is declared here rather than imported from `runtime/sandbox/`
 * for the same reason `PaneTemplate` arrives as a type-only import: the config
 * loader pulls this module in on every CLI boot, and a value import would drag
 * the docker gateway and `execa` along with it. `SandboxSecurityConfig` in
 * `runtime/sandbox/docker.ts` is the structural counterpart, and the two are
 * kept assignable by `profiles.security.test.ts`.
 */
export interface ProfileSecurity {
  /** `--network`. `none` also drops published ports. */
  network?: 'none' | 'bridge';
  /** `--pids-limit`; `0` omits the flag. */
  pidsLimit?: number;
  /** `--memory` as a docker size string (`'4g'`); `'0'` omits the flag. */
  memory?: string;
  /** Capabilities granted back on top of `--cap-drop=ALL`. */
  capAdd?: string[];
  /** `--security-opt no-new-privileges`. Read `docs/sandbox-security.md` before disabling. */
  noNewPrivileges?: boolean;
  /** Forward the host's `SSH_AUTH_SOCK`. Off unless a profile asks. */
  sshAgent?: boolean;
  /** The implicit agent-config and credential mounts. */
  implicitMounts?: boolean;
}

export interface RuntimeProfile {
  runtime: ProfileRuntimeKind;
  /** Required by `runtime: 'docker'`; a docker profile without one is not usable. */
  image?: string;
  /**
   * Translated from `permission` or from the upstream's `yolo: true`. Absent
   * means "whatever the phase already decided" — the profile does not override.
   */
  permission?: AgentPermission;
  /** Host variables forwarded into the runtime. */
  envPassthrough: string[];
  /** `${VAR}` placeholders are expanded against the runtime env at launch. */
  systemPrompt?: string;
  mounts?: MountSpec[];
  /** Sandbox hardening overrides. `runtime: 'docker'` only; absent means every default. */
  security?: ProfileSecurity;
  panes: PaneTemplate[];
}

/** A docker profile that actually has everything the sandbox needs. */
export type DockerRuntimeProfile = RuntimeProfile & { runtime: 'docker'; image: string };

/** The profile name looked up when nothing selects another one. */
export const DEFAULT_PROFILE_NAME = 'default';

/** The profile name whose runtime defaults to `docker` rather than `host`. */
export const SANDBOX_PROFILE_NAME = 'sandbox';

/**
 * The window everybody gets without configuring anything: the agent on the
 * left, a shell on a quarter of the width to its right.
 */
export const DEFAULT_PANES: readonly PaneTemplate[] = [
  { id: 'agent', kind: 'agent', focus: true },
  { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
];

/* ── cloning ────────────────────────────────────────────────────────────── */

export function clonePanes(panes: readonly PaneTemplate[]): PaneTemplate[] {
  return panes.map((pane) => ({ ...pane }));
}

function cloneMounts(mounts: readonly MountSpec[] | undefined): MountSpec[] | undefined {
  return mounts?.map((mount) => ({ ...mount }));
}

export function cloneProfile(profile: RuntimeProfile): RuntimeProfile {
  return {
    ...profile,
    envPassthrough: [...profile.envPassthrough],
    panes: clonePanes(profile.panes),
    ...(profile.mounts ? { mounts: cloneMounts(profile.mounts) } : {}),
    ...(profile.security
      ? {
          security: {
            ...profile.security,
            ...(profile.security.capAdd ? { capAdd: [...profile.security.capAdd] } : {}),
          },
        }
      : {}),
  };
}

export function cloneProfiles(
  profiles: Readonly<Record<string, RuntimeProfile>>,
): Record<string, RuntimeProfile> {
  return Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [name, cloneProfile(profile)]),
  );
}

/** The built-in profile map. A fresh copy every call, on purpose. */
export function defaultProfiles(): Record<string, RuntimeProfile> {
  return {
    [DEFAULT_PROFILE_NAME]: {
      runtime: 'host',
      envPassthrough: [],
      panes: clonePanes(DEFAULT_PANES),
    },
  };
}

/* ── parsing ────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * One pane declaration.
 *
 * Returns `null` — dropped, never fatal — for anything unusable. A `command`
 * pane with no command is the case that matters: the upstream drops it because
 * a pane that would open a shell where a service was expected is worse than a
 * missing pane, which is at least visible.
 */
export function parsePaneTemplate(raw: unknown, index: number): PaneTemplate | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== 'agent' && raw.kind !== 'shell' && raw.kind !== 'command') return null;

  const pane: PaneTemplate = {
    id: nonEmptyString(raw.id) ?? `pane-${index + 1}`,
    kind: raw.kind,
  };

  if (raw.split === 'right' || raw.split === 'bottom') pane.split = raw.split;
  if (typeof raw.sizePct === 'number' && Number.isFinite(raw.sizePct)) pane.sizePct = raw.sizePct;
  if (raw.focus === true) pane.focus = true;
  if (raw.cwd === 'repo' || raw.cwd === 'worktree') pane.cwd = raw.cwd;

  if (raw.kind === 'command') {
    const command = nonEmptyString(raw.command);
    if (command === undefined) return null;
    pane.command = command;
    const workingDir = nonEmptyString(raw.workingDir);
    if (workingDir !== undefined) pane.workingDir = workingDir;
  }

  return pane;
}

/** A pane list, falling back to the default window when it yields nothing. */
export function parsePaneTemplates(raw: unknown): PaneTemplate[] {
  if (!Array.isArray(raw)) return clonePanes(DEFAULT_PANES);

  const panes = raw
    .map((entry, index) => parsePaneTemplate(entry, index))
    .filter((pane): pane is PaneTemplate => pane !== null);

  return panes.length > 0 ? panes : clonePanes(DEFAULT_PANES);
}

function parseMounts(raw: unknown): MountSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const mounts = raw
    .filter(isRecord)
    .filter((entry) => typeof entry.hostPath === 'string' && entry.hostPath.length > 0)
    .map((entry) => ({
      hostPath: entry.hostPath as string,
      ...(typeof entry.guestPath === 'string' && entry.guestPath.length > 0
        ? { guestPath: entry.guestPath }
        : {}),
      ...(typeof entry.writable === 'boolean' ? { writable: entry.writable } : {}),
    }));

  return mounts.length > 0 ? mounts : undefined;
}

/**
 * Read the hardening overrides a profile declares.
 *
 * Tolerant like every other parser here: a value of the wrong type is dropped
 * rather than coerced, and a `security` that is not an object reads as absent.
 * A dropped field falls back to its hardened default, which is the direction a
 * typo has to fail in — the alternative is a configuration mistake quietly
 * turning the sandbox off.
 *
 * `undefined` when nothing valid was declared, so `security` never appears on a
 * profile as an empty object that reads like a deliberate declaration.
 */
export function parseProfileSecurity(raw: unknown): ProfileSecurity | undefined {
  if (!isRecord(raw)) return undefined;

  const security: ProfileSecurity = {};
  if (raw.network === 'none' || raw.network === 'bridge') security.network = raw.network;
  if (typeof raw.pidsLimit === 'number' && Number.isInteger(raw.pidsLimit) && raw.pidsLimit >= 0) {
    security.pidsLimit = raw.pidsLimit;
  }
  const memory = nonEmptyString(raw.memory);
  if (memory !== undefined) security.memory = memory;
  if (isStringArray(raw.capAdd) && raw.capAdd.length > 0) security.capAdd = [...raw.capAdd];
  if (typeof raw.noNewPrivileges === 'boolean') security.noNewPrivileges = raw.noNewPrivileges;
  if (typeof raw.sshAgent === 'boolean') security.sshAgent = raw.sshAgent;
  if (typeof raw.implicitMounts === 'boolean') security.implicitMounts = raw.implicitMounts;

  return Object.keys(security).length > 0 ? security : undefined;
}

/**
 * Resolve the profile's permission from the two accepted spellings.
 *
 * `permission` is Issue Flow's own and wins. `yolo: true` is the upstream's and
 * maps to `autonomous`; `yolo: false` maps to **nothing**, matching the upstream
 * (its own test asserts that a profile with `yolo: false` carries no `yolo` at
 * all) and keeping the phase's decision rather than overriding it with a
 * narrower one the profile never intended.
 */
export function parseProfilePermission(raw: Record<string, unknown>): AgentPermission | undefined {
  if (
    raw.permission === 'read-only' ||
    raw.permission === 'workspace' ||
    raw.permission === 'autonomous'
  ) {
    return raw.permission;
  }
  return raw.yolo === true ? 'autonomous' : undefined;
}

export function parseRuntimeProfile(
  raw: unknown,
  fallbackRuntime: ProfileRuntimeKind,
): RuntimeProfile {
  if (!isRecord(raw)) {
    return { runtime: fallbackRuntime, envPassthrough: [], panes: clonePanes(DEFAULT_PANES) };
  }

  const runtime: ProfileRuntimeKind = raw.runtime === 'docker' ? 'docker' : fallbackRuntime;
  const permission = parseProfilePermission(raw);
  const image = nonEmptyString(raw.image);
  const mounts = parseMounts(raw.mounts);
  const security = parseProfileSecurity(raw.security);

  return {
    runtime,
    envPassthrough: isStringArray(raw.envPassthrough) ? raw.envPassthrough : [],
    ...(permission === undefined ? {} : { permission }),
    panes: parsePaneTemplates(raw.panes),
    ...(typeof raw.systemPrompt === 'string' && raw.systemPrompt.length > 0
      ? { systemPrompt: raw.systemPrompt }
      : {}),
    ...(image === undefined ? {} : { image }),
    ...(mounts ? { mounts } : {}),
    ...(security ? { security } : {}),
  };
}

/**
 * A whole `profiles` map.
 *
 * `includeDefaultProfile` distinguishes the base layer, which must always
 * produce a usable `default`, from an overlay layer, where an absent section
 * means "override nothing" rather than "reset to the defaults".
 */
export function parseRuntimeProfiles(
  raw: unknown,
  includeDefaultProfile: boolean,
): Record<string, RuntimeProfile> {
  if (!isRecord(raw)) return includeDefaultProfile ? defaultProfiles() : {};

  const profiles: Record<string, RuntimeProfile> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim() === '') continue;
    // The one special-cased name: a profile called `sandbox` that forgets to
    // say `runtime: docker` still gets docker, which is what it meant.
    const fallbackRuntime: ProfileRuntimeKind = name === SANDBOX_PROFILE_NAME ? 'docker' : 'host';
    profiles[name.trim()] = parseRuntimeProfile(value, fallbackRuntime);
  }

  if (Object.keys(profiles).length === 0) {
    return includeDefaultProfile ? defaultProfiles() : {};
  }
  return profiles;
}

/**
 * Merge profile layers by name.
 *
 * A profile is replaced whole, never merged field by field: the upstream's
 * local overlay works the same way, and it is the behaviour a person expects
 * when they redefine `sandbox` — they are describing that profile, not patching
 * three of its keys onto a definition they cannot see.
 */
export function mergeProfileLayers(
  ...layers: ReadonlyArray<Readonly<Record<string, RuntimeProfile>>>
): Record<string, RuntimeProfile> {
  const merged: Record<string, RuntimeProfile> = {};
  for (const layer of layers) Object.assign(merged, cloneProfiles(layer));
  return merged;
}

/* ── lookups ────────────────────────────────────────────────────────────── */

/** `default` when it exists, otherwise the first declared profile. */
export function getDefaultProfileName(profiles: Readonly<Record<string, RuntimeProfile>>): string {
  if (profiles[DEFAULT_PROFILE_NAME]) return DEFAULT_PROFILE_NAME;
  return Object.keys(profiles)[0] ?? DEFAULT_PROFILE_NAME;
}

/**
 * Resolve a profile by name, falling back to the default one.
 *
 * The fallback is loud through `warn` rather than silent: a run that quietly
 * used `default` because `--profile sandox` was misspelled is a run whose
 * isolation nobody verified.
 */
export function resolveProfile(
  profiles: Readonly<Record<string, RuntimeProfile>>,
  name: string | undefined,
  warn?: (message: string) => void,
): { name: string; profile: RuntimeProfile } {
  const requested = name?.trim();
  if (requested !== undefined && requested !== '') {
    const found = profiles[requested];
    if (found !== undefined) return { name: requested, profile: cloneProfile(found) };
    warn?.(`Unknown runtime profile "${requested}"; using the default profile.`);
  }

  const fallbackName = getDefaultProfileName(profiles);
  const fallback = profiles[fallbackName];
  // An empty profile map still has to answer with something launchable, so the
  // built-in default is rebuilt rather than looked up.
  return {
    name: fallbackName,
    profile:
      fallback === undefined
        ? { runtime: 'host', envPassthrough: [], panes: clonePanes(DEFAULT_PANES) }
        : cloneProfile(fallback),
  };
}

/** Whether a profile can actually be launched as a container. */
export function isDockerProfile(
  profile: RuntimeProfile | undefined,
): profile is DockerRuntimeProfile {
  return (
    profile !== undefined &&
    profile.runtime === 'docker' &&
    typeof profile.image === 'string' &&
    profile.image.length > 0
  );
}

/**
 * Expand `${VAR}` placeholders against an environment map.
 *
 * Ported verbatim from `adapters/config.ts`. An unknown key becomes the empty
 * string rather than staying literal: a `${PORT}` that survived into a URL would
 * be handed to a browser as a broken address, while an empty one fails at the
 * place that built it.
 */
export function expandTemplate(template: string, env: Readonly<Record<string, string>>): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => env[key] ?? '');
}

/** The profile's system prompt with its placeholders resolved (§16). */
export function resolveProfileSystemPrompt(
  profile: RuntimeProfile,
  env: Readonly<Record<string, string>>,
): string | undefined {
  return profile.systemPrompt === undefined ? undefined : expandTemplate(profile.systemPrompt, env);
}

/**
 * The profile → tmux seam is one call, and it lives at the caller:
 *
 * ```ts
 * const plan = planSessionLayout({ projectId, branch, templates: profile.panes, context });
 * await ensureSessionLayout(tmux, plan, { force: profileChanged });
 * ```
 *
 * No wrapper is offered on purpose. This module is loaded by the configuration
 * loader (`src/config/runtime.ts`), and a wrapper would turn its `import type`
 * of the layout into a value import — which would drag the tmux gateway, and
 * `execa` behind it, into every CLI boot that reads configuration. `force` is
 * the whole of a profile switch: the layout itself is what changed, so
 * reattaching would show the previous one (C8).
 */
