CREATE TABLE rag_namespaces (
  id text PRIMARY KEY,
  name text UNIQUE NOT NULL,
  dimensions int NOT NULL CHECK (dimensions > 0),
  model text NOT NULL
);
CREATE TABLE rag_entries (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES rag_namespaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  title text,
  metadata jsonb NOT NULL DEFAULT '{}',
  filter_values jsonb NOT NULL DEFAULT '{}',
  content_hash text NOT NULL,
  importance real NOT NULL DEFAULT 1 CHECK (importance BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(namespace_id, key)
);
CREATE TABLE rag_chunks (
  entry_id text NOT NULL REFERENCES rag_entries(id) ON DELETE CASCADE,
  namespace_id text NOT NULL REFERENCES rag_namespaces(id) ON DELETE CASCADE,
  "order" int NOT NULL,
  text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY(entry_id, "order")
);
CREATE INDEX rag_chunks_tsv ON rag_chunks USING gin(tsv);
CREATE INDEX rag_chunks_namespace ON rag_chunks(namespace_id);
CREATE INDEX rag_entries_namespace_id ON rag_entries(namespace_id, id);
