-- +migrate Up
-- Company documents - licences, registrations, agreements and the like - kept
-- against the organization rather than an employee. Like employee documents,
-- the file lives in storage under a server-generated key; only its metadata is
-- stored here.
CREATE TABLE organization_documents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  note               TEXT,
  storage_key        TEXT NOT NULL,
  original_filename  TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  file_size_bytes    BIGINT NOT NULL CHECK (file_size_bytes > 0),
  checksum_sha256    TEXT,
  uploaded_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_documents_storage_key_unique UNIQUE (storage_key)
);

CREATE INDEX organization_documents_organization_idx ON organization_documents (organization_id, created_at DESC);
CREATE TRIGGER organization_documents_set_updated_at BEFORE UPDATE ON organization_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS organization_documents;
