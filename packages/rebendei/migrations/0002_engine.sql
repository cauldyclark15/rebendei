-- Migrate the unreleased bootstrap document columns to the storage contract.
DROP INDEX IF EXISTS documents_table_updated;
ALTER TABLE documents DROP COLUMN IF EXISTS created_ts;
ALTER TABLE documents DROP COLUMN IF EXISTS updated_ts;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS creation_time double precision NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000);
CREATE TABLE IF NOT EXISTS index_entries (
  table_name text NOT NULL,
  index_name text NOT NULL,
  key bytea NOT NULL,
  doc_id text NOT NULL,
  PRIMARY KEY (table_name, index_name, key, doc_id)
);
CREATE INDEX IF NOT EXISTS index_entries_document ON index_entries (table_name, doc_id);
CREATE TABLE IF NOT EXISTS commits (
  ts bigint PRIMARY KEY,
  writes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
