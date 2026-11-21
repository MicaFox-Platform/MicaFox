# Hub web app

## Purpose

The single-page app engineers use in the browser: the shell every feature plugs into, the shell's own screens
(setup, login, projects, settings), data loading and live updates. It is built from `@micafox/ui` only.

## Boundaries

- Owns:
  - the route tree, the navigation and the slots features fill;
  - the shell: top bar, switchers, user menu, status bar, loading, empty and error states, toasts;
  - the shell's screens, the typed API client, the events stream in the browser.
- Does not own: the look of anything, which is [UI](ui.md); a feature's screens, such as the debugger's and its
  list of connected apps, which come with the feature through [its web part](features.md#web-part).
- Constraints:
  - Served by the hub from the same origin, so the session cookie, the CSP and one image are enough.
  - The latest two versions of Chrome, Edge, Firefox and Safari, on screens 1280 px wide and wider; English only,
    with each package's UI strings in its `strings.ts`; dates stored in UTC and shown in the browser's time zone.
  - WCAG 2.2 AA: everything works from the keyboard, focus is always visible, contrast is checked.

## Interactions

```text
┌──────────────────────── Browser ─────────────────────────┐            ┌──────────── Hub ─────────────┐
│ router: shell routes + feature routes                    │  fetch     │ /api/v1, /api/internal       │
│ data: TanStack Query over the typed API client           │───────────▶│                              │
│                                                          │◀───────────│ JSON, problem+json           │
│ events: EventSource → invalidate the stale queries       │◀───────────│ /api/internal/events (SSE)   │
└──────────────────────────────────────────────────────────┘  events    └──────────────────────────────┘
```

### Routes

| Path                                    | Screen                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| `/setup`, `/login`                      | the first owner; logging in                                         |
| `/invite/$token`, `/reset/$token`       | joining by an invite; setting a new password                        |
| `/projects`                             | projects of the organization; admins create them                    |
| `/p/$projectId/e/$environmentId`        | an environment's overview: the `environment.overview` slot          |
| `/p/$projectId/e/$environmentId/<name>` | a feature's routes, such as `/debugger`                             |
| `/settings/org`                         | members, roles, invites; the `org.settings` slot                    |
| `/settings/projects/$projectId`         | environments and project keys; the `project.settings` slot          |
| `/settings/account`                     | name, password, logging out everywhere; the `account.settings` slot |

`/` opens the last environment used, or `/projects`. Anything else is the 404 screen.

### Screens

```text
┌─ MICAFOX ───────────────────────────────── [ checkout ▾ ] [ production ▾ ] [ ann@acme ▾ ] ─┐
│ ┌────────────────┐ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ > OVERVIEW     │ │ PRODUCTION · OVERVIEW                                               │ │
│ │   DEBUGGER     │ │ ┌─ slot: environment.overview ─┐ ┌─ slot: environment.overview ─┐   │ │
│ │                │ │ │ a feature's card             │ │ a feature's card             │   │ │
│ │ ────────────── │ │ └──────────────────────────────┘ └──────────────────────────────┘   │ │
│ │   SETTINGS     │ │                                                                     │ │
│ └────────────────┘ └─────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ● LIVE                                                         v0.1.0 · hub · [ SOURCE ]   │
└────────────────────────────────────────────────────────────────────────────────────────────┘

┌─ SETUP ─────────────────────────────┐   ┌─ CHECKOUT · SETTINGS ───────────────────────────────────────┐
│ SETUP TOKEN   [ mfx_setup_…       ] │   │ [ Environments ] [ Keys ]                                   │
│ ORGANIZATION  [ Acme              ] │   │ PRODUCTION                                     [ NEW KEY ]  │
│ NAME          [ Ann               ] │   │ NAME     KEY            CREATED      LAST USED              │
│ EMAIL         [ ann@acme.dev      ] │   │ deploy   mfx_pk_7Qx2…   2026-11-19   2 min ago   [ REVOKE ] │
│ PASSWORD      [ ••••••••••••      ] │   │ ┌─ NEW KEY · SHOWN ONCE ──────────────────────────────────┐ │
│               [ CREATE OWNER ]      │   │ │ MICAFOX_HUB_URL=wss://hub.acme.dev/sdk                  │ │
└─────────────────────────────────────┘   │ │ MICAFOX_TOKEN=mfx_pk_…                       [ COPY ]   │ │
                                          │ └─────────────────────────────────────────────────────────┘ │
                                          └─────────────────────────────────────────────────────────────┘
```

- The top bar holds the project and environment switchers and the user menu: account, theme, log out. The
  organization is not shown while there is only one.
- The navigation lists the features' `nav` entries, then Settings. An extension's entry without its entitlement
  shows an "Upgrade" screen; S2 has no such entry, so the screen never appears.
- The status bar shows whether live updates are connected, the version and build, and a Source link to the code of
  the running version, as AGPL-3.0 asks.
- Login, invite and reset screens are windows like Setup; the account screen lists the password form and
  "log out everywhere".
- Loading shows a placeholder after 300 ms; an empty list says what to do next, with the action; a failed request
  shows its problem's title inline; 403, 404 and 500 are screens, the last with the request id. Done actions show a
  toast. An expired session goes to `/login` and back to the same page after it.

## Layout

```text
hub/core/src/web/
├── index.ts         the web entry: defineWebFeature, the API client, hooks, shell parts features use
├── app.tsx          mounts the router, the query client and the theme
├── shell/           top bar, navigation, switchers, status bar, error screens, toasts
├── routes/          setup, login, invite, reset, projects, settings
├── data/            the typed API client, the query client, problems as errors
├── events/          the events stream and the invalidations it triggers
├── feature/         the web feature contract: features.md
└── strings.ts       the shell's UI strings
```

## Key flows

### Loading data

1. Screens read through TanStack Query; the API client's request and response types come from the TypeBox schemas
   in each package's `./schema`, the same the server validates with.
2. A problem response becomes a typed error. Forms use react-hook-form with the same schemas, and a `validation`
   problem's errors land on their fields.
3. A change invalidates the queries it affects once the server answers.

### Pushing a live update

1. After login the app opens an `EventSource` on `/api/internal/events`; the stream starts with `reset`, then sends
   each [event](server.md#events) of the user's organizations, and a comment every 25 s to keep proxies from
   closing it.
2. `reset` invalidates every query; any other event invalidates the queries its feature's `events` map names, and
   `entitlements.changed` reloads the entitlements.
3. The browser reconnects by itself, and every reconnect starts with `reset`, so nothing missed while offline stays
   stale. The status bar shows the state; a stream the server ends on logout leads to `/login`. Why SSE:
   [ADR 0032](../../adr/hub/web/0032-push-live-updates-to-the-ui-over-server-sent-events.md).

### Testing

1. Component tests with Vitest, Testing Library and happy-dom run in `pnpm verify` and count toward coverage, with
   axe checks.
2. `pnpm test:e2e` runs Playwright in Chromium against both builds, the basic hub and the hub, in a CI job of its
   own.

## Decisions

- [0032. Push live updates to the UI over server-sent events](../../adr/hub/web/0032-push-live-updates-to-the-ui-over-server-sent-events.md)
- [0033. Build the web app with React, Vite and TanStack](../../adr/hub/web/0033-build-the-web-app-with-react-vite-and-tanstack.md)
- [0034. Style the UI with CSS Modules, tokens and React Aria](../../adr/hub/ui/0034-style-the-ui-with-css-modules-tokens-and-react-aria.md)
