# Contributing to Margin

## Quick start

```sh
bun install
bun migrate
bun test
bun run typecheck
```

To run the server against Google you also need an OAuth client, a Picker key, and a couple of secrets in `.env`. See [`setup.md`](./setup.md). Deployment to Fly.io is in [`deployment.md`](./deployment.md); CI tiers and integration-test secrets are in [`testing.md`](./testing.md).

## Where things live

- [`spec.md`](./spec.md): design, data model, per-phase build plan, Google-side constraints.
- [`AGENTS.md`](../AGENTS.md): repo layout and code conventions (Bun usage, domain/HTTP/CLI boundaries, schema migrations, secrets at rest, test layout).
- [`surfaces/extension/README.md`](../surfaces/extension/README.md): extension build pipeline, popup state machine, Picker mechanics.

Read `AGENTS.md` before opening a PR.

## Pull requests

- `bun test` and `bun run typecheck` must pass.
- Keep diffs focused. Match the surrounding style. Don't introduce abstractions beyond what the task requires.
- If you touch a phase listed in [`spec.md` §12](./spec.md#12-build-sequence), keep its `Status:` line current.
