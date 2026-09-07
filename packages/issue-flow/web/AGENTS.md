# Dashboard rules

The dashboard is a Svelte 5/Vite application served by the monitoring server.
It displays projects, active and completed executions, worktrees, agent
sessions, terminal access, configuration, integrations, and conversations.

## Contract and data flow

- Network calls go through `src/lib/api.ts` and the shared
  `issue-flow-contract` package.
- The active project prefix comes from the first URL segment; `api`, `ws`,
  `assets`, and `health` are never project prefixes.
- Initial data is fetched over HTTP. Live execution updates arrive through
  `/api/stream`; reconnect logic may refetch the same resources.
- Do not invent state the API does not report. Unknown values remain unknown.
- Mutations are gated by server capabilities and the `writable` flag.

## UI structure

- `App.svelte` coordinates selection and page-level state. Domain rendering
  belongs in components under `src/lib`.
- Desktop and mobile layouts share stores and request helpers; they must not
  implement separate business rules.
- Worktree conversation views use the attach/history/message/interrupt API.
  Sending and interrupting are followed by a history refresh.
- Terminal sockets are created only after obtaining a server token and are
  scoped to the selected session or branch.

## Styling and accessibility

- Design tokens live in `src/tokens.css`; components consume semantic tokens.
- All named palettes must satisfy the contrast tests.
- Interactive controls require accessible names, visible focus, keyboard
  operation, and disabled/loading states.
- Respect reduced motion. Avoid layout shifts during stream updates.
- Keep mobile actions reachable without relying on hover.

## Testing

- Component behavior is tested with Vitest and Testing Library.
- Contract changes require matching server, contract-package, and UI tests.
- Run `npm run check:web`, `npm run test:web`, and `npm run build:web` for UI
  changes.
- Before release, exercise the built dashboard in a browser against a real
  monitor, including project selection and a representative execution view.
