CREATE EXTENSION IF NOT EXISTS vector;

-- Global commit clock: every mutation commit takes the next value.
CREATE SEQUENCE IF NOT EXISTS commit_ts;

-- All user documents live here; a "table" is a namespace, not a Postgres table.
CREATE TABLE IF NOT EXISTS documents (
  table_name  text        NOT NULL,
  id          text        NOT NULL,
  value       jsonb       NOT NULL,
  created_ts  bigint      NOT NULL,
  updated_ts  bigint      NOT NULL,
  PRIMARY KEY (table_name, id)
);

CREATE INDEX IF NOT EXISTS documents_table_updated ON documents (table_name, updated_ts);
