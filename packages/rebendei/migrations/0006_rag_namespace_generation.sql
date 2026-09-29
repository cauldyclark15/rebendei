-- Stable namespace IDs still identify the namespace name. A fresh generation
-- distinguishes delete/recreate even when model and dimensions are unchanged.
ALTER TABLE rag_namespaces ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid();
