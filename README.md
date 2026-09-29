# Rebendei

An open-source reactive backend in the spirit of [Convex](https://github.com/get-convex/convex-backend):
write server functions in plain JavaScript, and every client subscribed to a query
gets fresh results the moment the data it read changes.

- **Language:** vanilla JavaScript (ES modules, JSDoc for types — no build step)
- **Runtime:** [Bun](https://bun.sh)
- **Database:** PostgreSQL + [pgvector](https://github.com/pgvector/pgvector)
- **Dependencies:** none at runtime — Bun's built-in HTTP/WebSocket server and Postgres client

> Status: early scaffold. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the plan.

## Create a backend

```sh
npx create-rebendei my-app      # or: bunx create-rebendei my-app
cd my-app
bun run db:up                   # Postgres 17 + pgvector in Docker
bun run dev                     # http://localhost:3210
```

Needs [Bun](https://bun.sh) and Docker (or your own Postgres with pgvector via `DATABASE_URL`).

## CLI

```
rebendei dev       apply migrations, then start the server
rebendei start     start the server
rebendei migrate   apply pending migrations
rebendei db:up     start local Postgres + pgvector
rebendei db:down   stop it
```

## Working on Rebendei itself

```sh
cp .env.example .env
bun install
bun run db:up
bun run dev
```

## Tests

```sh
bun run db:up && bun test
```

## Layout

```
packages/
  rebendei/         the backend + `rebendei` CLI (npm: rebendei)
    bin/ src/ migrations/ test/
  create-rebendei/  project generator (npm: create-rebendei)
    template/
```

## Not affiliated

Rebendei is an independent project. It is not affiliated with Convex, Inc. and
contains no Convex source code.

## License

MIT
