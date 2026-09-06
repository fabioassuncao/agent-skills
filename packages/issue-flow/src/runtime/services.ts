import { connect, type Socket } from 'node:net';
import { expandTemplate } from './profiles.js';
import type { ServiceRuntimeState } from './types.js';

/**
 * Services — the long-running processes a worktree owns, and whether they are up.
 *
 * Ported from WebMux `backend/src/adapters/port-probe.ts` (57 lines) and the
 * pure `allocateServicePorts` of `backend/src/domain/policies.ts:96` @ d8c9d5f
 * (§19 of the absorption plan). Two independent responsibilities that only meet
 * at the `portEnv` key:
 *
 * - **Allocation is a pure function.** It reads the ports already handed out to
 *   other worktrees, finds the lowest free slot and applies
 *   `portStart + slot * portStep` to every service. No probing, no I/O, no
 *   clock — which is what makes an allocation reproducible and testable, and
 *   what lets the worktree layer take `allocatedPorts` as an *input* rather than
 *   discovering them.
 * - **Health is a probe.** A TCP connect with a hard 300 ms ceiling, attempted
 *   on `127.0.0.1` **and** `::1` in parallel, resolving `true` on the first
 *   success. Both families are load-bearing: a server bound only to IPv6 on a
 *   dual-stack host answers `::1` and refuses `127.0.0.1`, and a probe that
 *   tried one of them would report a running service as down.
 */

/** One long-running process a profile declares. */
export interface ServiceSpec {
  name: string;
  /** Environment variable that carries the allocated port into the worktree. */
  portEnv: string;
  /** First port of the range. A service without one is never allocated. */
  portStart?: number;
  /** Distance between consecutive worktrees' ports. Defaults to 1. */
  portStep?: number;
  /** `${VAR}` placeholders resolved against the worktree's runtime env. */
  urlTemplate?: string;
}

/* ── parsing ────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the `services` list.
 *
 * Tolerant like every other parser in this absorption: an entry without both a
 * `name` and a `portEnv` cannot be allocated or reported, so it is dropped
 * rather than failing the load.
 */
export function parseServiceSpecs(raw: unknown): ServiceSpec[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(isRecord)
    .filter((entry) => typeof entry.name === 'string' && typeof entry.portEnv === 'string')
    .map((entry) => ({
      name: entry.name as string,
      portEnv: entry.portEnv as string,
      ...(typeof entry.portStart === 'number' && Number.isFinite(entry.portStart)
        ? { portStart: entry.portStart }
        : {}),
      ...(typeof entry.portStep === 'number' && Number.isFinite(entry.portStep)
        ? { portStep: entry.portStep }
        : {}),
      ...(typeof entry.urlTemplate === 'string' && entry.urlTemplate.length > 0
        ? { urlTemplate: entry.urlTemplate }
        : {}),
    }));
}

/* ── allocation ─────────────────────────────────────────────────────────── */

/** What allocation needs to know about a worktree that already exists. */
export interface AllocatedPortsHolder {
  allocatedPorts: Record<string, number>;
}

/**
 * Ports for a new worktree, given the ones already in use.
 *
 * Ported literally from `domain/policies.ts`. Four details are the port, not
 * decoration:
 *
 * - **The first allocatable service is the reference.** Slots are derived from
 *   its range alone and then applied to every service, so one worktree's ports
 *   stay aligned across services — `FRONTEND_PORT 3020` next to `PORT 5121`,
 *   never a mix of two different slots.
 * - **A port that does not sit on the reference's grid is ignored.** It was
 *   allocated under a different `portStart`/`portStep`, so it says nothing about
 *   which slot of *this* configuration is free.
 * - **Slots start at 1, not 0.** Slot 0 is the repository's own ports — the
 *   dev server a person already runs in the main checkout — and handing it to a
 *   worktree would collide with it on the first allocation.
 * - **Services without `portStart` are absent from the result**, rather than
 *   present with a null. They are declared for their health line, not for a
 *   port.
 */
export function allocateServicePorts(
  existing: readonly AllocatedPortsHolder[],
  services: readonly ServiceSpec[],
): Record<string, number> {
  const allocatable = services.filter((service) => service.portStart != null);
  const reference = allocatable[0];
  if (reference === undefined || reference.portStart === undefined) return {};

  const referenceStart = reference.portStart;
  const referenceStep = reference.portStep ?? 1;
  const occupiedSlots = new Set<number>();

  for (const meta of existing) {
    const port = meta.allocatedPorts[reference.portEnv];
    if (port === undefined || !Number.isInteger(port) || port < referenceStart) continue;
    const diff = port - referenceStart;
    if (referenceStep === 0 || diff % referenceStep !== 0) continue;
    occupiedSlots.add(diff / referenceStep);
  }

  let slot = 1;
  while (occupiedSlots.has(slot)) slot += 1;

  const result: Record<string, number> = {};
  for (const service of allocatable) {
    const start = service.portStart;
    if (start === undefined) continue;
    result[service.portEnv] = start + slot * (service.portStep ?? 1);
  }
  return result;
}

/* ── health ─────────────────────────────────────────────────────────────── */

/** Hard ceiling for one probe, both families included. Upstream's number. */
export const PORT_PROBE_TIMEOUT_MS = 300;

/**
 * Both loopback families, probed in parallel.
 *
 * Not a preference order: a service bound to one of them is invisible on the
 * other, and asking only the first would report it as down.
 */
export const PORT_PROBE_HOSTNAMES: readonly string[] = ['127.0.0.1', '::1'];

export interface PortProbe {
  isListening(port: number): Promise<boolean>;
}

export interface PortProbeOptions {
  timeoutMs?: number;
  hostnames?: readonly string[];
}

/**
 * A TCP probe that answers within `timeoutMs` no matter what the network does.
 *
 * The upstream leaves its sockets to Bun on the timeout path; here every socket
 * is destroyed before resolving. In Node an open connection attempt keeps a
 * handle referenced, and a probe that resolved `false` while leaving two of them
 * behind would hold the process open — a probe that answers but does not let the
 * CLI exit is not an answer.
 */
export function createPortProbe(options: PortProbeOptions = {}): PortProbe {
  const timeoutMs = options.timeoutMs ?? PORT_PROBE_TIMEOUT_MS;
  const hostnames = options.hostnames ?? PORT_PROBE_HOSTNAMES;

  return {
    isListening(port: number): Promise<boolean> {
      if (hostnames.length === 0) return Promise.resolve(false);

      return new Promise<boolean>((resolvePromise) => {
        const sockets: Socket[] = [];
        let settled = false;
        let pending = hostnames.length;

        const finish = (result: boolean): void => {
          settled = true;
          clearTimeout(timer);
          for (const socket of sockets) socket.destroy();
          resolvePromise(result);
        };

        // The first success wins; failure needs every family to have answered,
        // which is what makes a refused IPv4 connect on a v6-only service
        // harmless instead of decisive.
        const settle = (result: boolean): void => {
          if (settled) return;
          if (result) {
            finish(true);
            return;
          }
          pending -= 1;
          if (pending === 0) finish(false);
        };

        const timer = setTimeout(() => {
          if (!settled) finish(false);
        }, timeoutMs);
        // A probe must never be the reason a command stays alive.
        timer.unref?.();

        for (const hostname of hostnames) {
          let socket: Socket;
          try {
            socket = connect({ host: hostname, port });
          } catch {
            // An unusable family (no IPv6 stack at all) is one answer, not a throw.
            settle(false);
            continue;
          }
          sockets.push(socket);
          socket.once('connect', () => {
            socket.end();
            settle(true);
          });
          socket.once('error', () => settle(false));
        }
      });
    },
  };
}

/**
 * A service's state as the monitor and the reconciler read it.
 *
 * `ServiceRuntimeState` (`runtime/types.ts`) is the contract the runtime already
 * publishes; this adds the resolved `url`, which the upstream carries and the
 * panel needs to make the port clickable.
 */
export interface ServiceHealth extends ServiceRuntimeState {
  url: string | null;
}

function isUsablePort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Probe every service of a worktree, in parallel.
 *
 * The status mapping is deliberately narrow: a probe can only tell `ready` from
 * `stopped`. `starting` and `failed` are lifecycle facts — somebody launched the
 * process and it has not answered yet, or it exited — and inventing them from a
 * refused connection would make the panel assert something nobody observed.
 */
export async function probeServices(
  services: readonly ServiceSpec[],
  allocatedPorts: Readonly<Record<string, number>>,
  probe: PortProbe,
  runtimeEnv: Readonly<Record<string, string>> = {},
): Promise<ServiceHealth[]> {
  return Promise.all(
    services.map(async (service) => {
      const allocated = allocatedPorts[service.portEnv];
      const port = isUsablePort(allocated) ? allocated : null;
      const listening = port === null ? false : await probe.isListening(port);
      return {
        name: service.name,
        port,
        status: listening ? ('ready' as const) : ('stopped' as const),
        detail: port === null ? 'no port allocated' : null,
        url:
          port !== null && service.urlTemplate !== undefined
            ? expandTemplate(service.urlTemplate, runtimeEnv)
            : null,
      };
    }),
  );
}
