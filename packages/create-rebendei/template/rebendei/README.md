# Server functions

- `schema.js`: messages table and channel index.
- `messages.js`: live list, validated send, scheduled reminder, internal clear.
- `crons.js`: harmless daily internal mutation at 09:00 UTC.
- `rag.js`: local or hosted model configuration.
- `knowledge.js`: ingest, retrieve, ask, subscribe to entry metadata, remove.

Use paths like `messages:list` and `knowledge:ingest`. Internal functions are
not exposed to HTTP or WebSocket clients. See the app's [README](../README.md).
