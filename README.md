# Rebendei

An open-source reactive backend in the spirit of [Convex](https://github.com/get-convex/convex-backend):
write server functions in plain JavaScript, and every client subscribed to a query
gets fresh results the moment the data it read changes.

- **Language:** vanilla JavaScript (ES modules, JSDoc for types — no build step)
- **Runtime:** [Bun](https://bun.sh)
- **Database:** PostgreSQL + [pgvector](https://github.com/pgvector/pgvector)
- **Dependencies:** none at runtime — Bun's built-in HTTP/WebSocket server and Postgres client

> Status: early scaffold. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the plan.

## Quick start

```sh
cp .env.example .env
bun run db:up       # starts Postgres 17 + pgvector on port 54329
bun run migrate     # applies SQL migrations
bun run dev         # server on http://localhost:3210
curl localhost:3210/health
```

## Tests

```sh
bun run db:up && bun test
```

## Layout

```
packages/
  server/        the backend (HTTP + WebSocket, function runtime, sync engine)
    src/
    migrations/  plain SQL, applied in filename order
    test/
```

## Not affiliated

Rebendei is an independent project. It is not affiliated with Convex, Inc. and
contains no Convex source code.

## License

MIT
