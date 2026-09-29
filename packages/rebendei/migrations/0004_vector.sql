-- Physical pgvector tables are managed transactionally by the vector schema hook.
CREATE TABLE vector_indexes (
  table_name text NOT NULL,
  index_name text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 2000),
  vector_field text NOT NULL,
  filter_fields jsonb NOT NULL,
  pg_table_name text NOT NULL UNIQUE,
  PRIMARY KEY (table_name, index_name)
);
