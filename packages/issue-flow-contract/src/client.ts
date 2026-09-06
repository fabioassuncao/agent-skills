import { type InitClientArgs, initClient } from '@ts-rest/core';
import { apiContract } from './contract.js';

/**
 * The typed client every dashboard call goes through.
 *
 * PORT of `packages/api-contract/src/client.ts` from windmill-labs/webmux
 * @ d8c9d5f (107 lines), unchanged in behaviour. Two details carry their own
 * reason and are kept verbatim:
 *
 * - **`withEncodedPathParams`.** ts-rest interpolates path params into the URL
 *   verbatim, so a branch called `feature/search` would produce a path with an
 *   extra segment and hit a different route. Encoding happens here, once, at
 *   the boundary — not at every call site.
 * - **`errorMessageFromResponse` recursing through a string body.** A server
 *   that answers `Content-Type: text/plain` with JSON in it is a real case
 *   (proxies do it), and without the recursion the user is shown the raw JSON
 *   instead of the message inside it.
 */

export type ApiClientOptions = Omit<InitClientArgs, 'baseUrl'>;

export function createApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  return initClient(apiContract, {
    baseUrl,
    throwOnUnknownStatus: true,
    baseHeaders: {},
    ...options,
  });
}

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

type SuccessBody<TResponse> = Extract<TResponse, { status: SuccessStatus }> extends {
  body: infer TBody;
}
  ? TBody
  : never;

type UnwrappedClient<TClient> = {
  [K in keyof TClient]: TClient[K] extends (...args: infer TArgs) => Promise<infer TResponse>
    ? (...args: TArgs) => Promise<SuccessBody<TResponse>>
    : TClient[K];
};

type RouteCall = (...args: unknown[]) => Promise<unknown>;
type RouteResponse = { status: number; body: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRouteResponse(value: unknown): value is RouteResponse {
  return (
    isRecord(value) && 'status' in value && typeof value.status === 'number' && 'body' in value
  );
}

function unwrapResponse(response: unknown): unknown {
  if (!isRouteResponse(response)) {
    throw new Error('Resposta malformada da API.');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(errorMessageFromResponse(response.body, response.status));
  }
  return response.body;
}

function errorMessageFromResponse(body: unknown, status: number): string {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      return errorMessageFromResponse(parsed, status);
    } catch {
      return body.trim() || `HTTP ${status}`;
    }
  }
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return `HTTP ${status}`;
}

// ts-rest interpolates path params verbatim, so names like `feature/foo`
// must be encoded before they are inserted into `/api/.../:name/...`.
function withEncodedPathParams(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  if (
    !first ||
    typeof first !== 'object' ||
    !('params' in first) ||
    !first.params ||
    typeof first.params !== 'object'
  ) {
    return args;
  }

  const encodedParams = Object.fromEntries(
    Object.entries(first.params).map(([key, value]) => [key, encodeURIComponent(String(value))]),
  );

  return [
    {
      ...first,
      params: encodedParams,
    },
    ...rest,
  ];
}

function wrapRouteCall(routeCall: RouteCall): RouteCall {
  return async (...args: unknown[]) =>
    unwrapResponse(await routeCall(...withEncodedPathParams(args)));
}

function wrapClient<TClient extends Record<string, unknown>>(
  client: TClient,
): UnwrappedClient<TClient> {
  return Object.fromEntries(
    Object.entries(client).map(([key, value]) => {
      if (typeof value === 'function') {
        return [
          key,
          wrapRouteCall((...args) => Promise.resolve(Reflect.apply(value, undefined, args))),
        ];
      }
      if (isRecord(value)) {
        return [key, wrapClient(value)];
      }
      return [key, value];
    }),
  ) as UnwrappedClient<TClient>;
}

export type ApiClient = UnwrappedClient<ReturnType<typeof createApiClient>>;

export function createApi(baseUrl: string, options: ApiClientOptions = {}): ApiClient {
  return wrapClient(createApiClient(baseUrl, options));
}
