// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${VAR}` is the placeholder syntax expandTemplate resolves; these are data, not template literals.
import { describe, expect, it } from 'vitest';
import {
  allocateServicePorts,
  createPortProbe,
  PORT_PROBE_HOSTNAMES,
  PORT_PROBE_TIMEOUT_MS,
  type PortProbe,
  parseServiceSpecs,
  probeServices,
  type ServiceSpec,
} from './services.js';

/**
 * `allocateServicePorts` is ported from WebMux
 * `backend/src/__tests__/domain-policies.test.ts` @ d8c9d5f (its single case,
 * kept verbatim in intent) plus the cases the upstream never wrote for the
 * branches it does have: the grid filter, the missing reference and the service
 * that declares no range.
 */

const frontend: ServiceSpec = {
  name: 'frontend',
  portEnv: 'FRONTEND_PORT',
  portStart: 3000,
  portStep: 10,
};
const backend: ServiceSpec = { name: 'backend', portEnv: 'PORT', portStart: 5101, portStep: 10 };

describe('allocateServicePorts', () => {
  it('allocates the first free slot across existing worktree metadata', () => {
    const ports = allocateServicePorts(
      [
        { allocatedPorts: { FRONTEND_PORT: 3010, PORT: 5111 } },
        { allocatedPorts: { FRONTEND_PORT: 3030, PORT: 5131 } },
      ],
      [frontend, backend],
    );

    expect(ports).toEqual({ FRONTEND_PORT: 3020, PORT: 5121 });
  });

  // Slot 0 is the repository's own ports — the dev server somebody already runs
  // in the main checkout. Handing it out would collide on the first worktree.
  it('never hands out slot 0', () => {
    expect(allocateServicePorts([], [frontend])).toEqual({ FRONTEND_PORT: 3010 });
  });

  it('defaults the step to 1', () => {
    expect(
      allocateServicePorts([], [{ name: 'api', portEnv: 'API_PORT', portStart: 4100 }]),
    ).toEqual({
      API_PORT: 4101,
    });
  });

  it('keeps every service on the slot of the first allocatable one', () => {
    const ports = allocateServicePorts(
      [{ allocatedPorts: { FRONTEND_PORT: 3010 } }],
      [frontend, backend],
    );
    expect(ports).toEqual({ FRONTEND_PORT: 3020, PORT: 5121 });
  });

  // A port allocated under a different range says nothing about which slot of
  // this configuration is free, so it must not occupy one.
  it('ignores a port that does not sit on the reference grid', () => {
    const ports = allocateServicePorts(
      [{ allocatedPorts: { FRONTEND_PORT: 3015 } }, { allocatedPorts: { FRONTEND_PORT: 2000 } }],
      [frontend],
    );
    expect(ports).toEqual({ FRONTEND_PORT: 3010 });
  });

  it('ignores a worktree that allocated nothing for the reference service', () => {
    expect(allocateServicePorts([{ allocatedPorts: { OTHER: 9000 } }], [frontend])).toEqual({
      FRONTEND_PORT: 3010,
    });
  });

  it('skips over occupied slots until it finds a gap', () => {
    const ports = allocateServicePorts(
      [
        { allocatedPorts: { FRONTEND_PORT: 3010 } },
        { allocatedPorts: { FRONTEND_PORT: 3020 } },
        { allocatedPorts: { FRONTEND_PORT: 3040 } },
      ],
      [frontend],
    );
    expect(ports).toEqual({ FRONTEND_PORT: 3030 });
  });

  it('allocates nothing when no service declares a range', () => {
    expect(allocateServicePorts([], [{ name: 'db', portEnv: 'DB_PORT' }])).toEqual({});
    expect(allocateServicePorts([], [])).toEqual({});
  });

  it('leaves a rangeless service out of the result instead of nulling it', () => {
    const ports = allocateServicePorts([], [frontend, { name: 'db', portEnv: 'DB_PORT' }]);
    expect(ports).toEqual({ FRONTEND_PORT: 3010 });
    expect('DB_PORT' in ports).toBe(false);
  });
});

describe('parseServiceSpecs', () => {
  it('reads the declared shape', () => {
    expect(
      parseServiceSpecs([
        {
          name: 'API',
          portEnv: 'API_PORT',
          portStart: 4100,
          portStep: 10,
          urlTemplate: 'http://localhost:${API_PORT}',
        },
      ]),
    ).toEqual([
      {
        name: 'API',
        portEnv: 'API_PORT',
        portStart: 4100,
        portStep: 10,
        urlTemplate: 'http://localhost:${API_PORT}',
      },
    ]);
  });

  it('drops entries with no name or no portEnv', () => {
    expect(parseServiceSpecs([{ name: 'API' }, { portEnv: 'API_PORT' }, 'api', null])).toEqual([]);
  });

  it('drops non-finite ports and an empty url template', () => {
    expect(
      parseServiceSpecs([
        {
          name: 'API',
          portEnv: 'API_PORT',
          portStart: Number.NaN,
          portStep: '10',
          urlTemplate: '',
        },
      ]),
    ).toEqual([{ name: 'API', portEnv: 'API_PORT' }]);
  });

  it('reads a missing or non-array section as no services', () => {
    expect(parseServiceSpecs(undefined)).toEqual([]);
    expect(parseServiceSpecs({ api: {} })).toEqual([]);
  });
});

describe('the probe contract', () => {
  it('keeps the upstream ceiling and both loopback families', () => {
    expect(PORT_PROBE_TIMEOUT_MS).toBe(300);
    expect([...PORT_PROBE_HOSTNAMES]).toEqual(['127.0.0.1', '::1']);
  });

  it('answers false without probing when there is no family to try', () => {
    return expect(createPortProbe({ hostnames: [] }).isListening(1234)).resolves.toBe(false);
  });
});

function fakeProbe(listening: readonly number[]): PortProbe {
  return { isListening: async (port) => listening.includes(port) };
}

describe('probeServices', () => {
  it('reports a listening service as ready, with its url expanded', async () => {
    const states = await probeServices(
      [
        {
          name: 'frontend',
          portEnv: 'FRONTEND_PORT',
          urlTemplate: 'http://localhost:${FRONTEND_PORT}',
        },
      ],
      { FRONTEND_PORT: 3020 },
      fakeProbe([3020]),
      { FRONTEND_PORT: '3020' },
    );

    expect(states).toEqual([
      { name: 'frontend', port: 3020, status: 'ready', detail: null, url: 'http://localhost:3020' },
    ]);
  });

  it('reports an allocated but silent port as stopped', async () => {
    const [state] = await probeServices([frontend], { FRONTEND_PORT: 3020 }, fakeProbe([]));
    expect(state?.status).toBe('stopped');
    expect(state?.detail).toBeNull();
  });

  // A probe can only tell `ready` from `stopped`. `starting` and `failed` are
  // lifecycle facts; inventing them from a refused connection would make the
  // panel assert something nobody observed.
  it('never invents starting or failed', async () => {
    const states = await probeServices(
      [frontend, backend],
      { FRONTEND_PORT: 3020 },
      fakeProbe([3020]),
    );
    expect(states.map((state) => state.status)).toEqual(['ready', 'stopped']);
  });

  it('says so when no port was allocated, and never probes one', async () => {
    const probed: number[] = [];
    const [state] = await probeServices(
      [frontend],
      {},
      {
        isListening: async (port) => {
          probed.push(port);
          return true;
        },
      },
    );

    expect(state).toEqual({
      name: 'frontend',
      port: null,
      status: 'stopped',
      detail: 'no port allocated',
      url: null,
    });
    expect(probed).toEqual([]);
  });

  it('treats an out-of-range allocation as no port', async () => {
    const [state] = await probeServices([frontend], { FRONTEND_PORT: 70000 }, fakeProbe([70000]));
    expect(state?.port).toBeNull();
    expect(state?.status).toBe('stopped');
  });

  it('leaves the url null when the service declares no template', async () => {
    const [state] = await probeServices([frontend], { FRONTEND_PORT: 3020 }, fakeProbe([3020]));
    expect(state?.url).toBeNull();
  });
});
