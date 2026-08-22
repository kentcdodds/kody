-- Derived skip cache for Vectorize embeddings. A row means this vector id in
-- this owner namespace was last upserted from embed text that hashes to
-- content_hash (model + dimensions + fingerprint version + truncated text +
-- canonical Vectorize metadata).
-- User-owned rows use the account stable user id; builtin capability vectors
-- use the reserved __kody_builtin__ namespace as user_id. Account deletion
-- removes user-owned rows. A force reindex ignores these hashes.
CREATE TABLE vector_embed_fingerprints (
	user_id TEXT NOT NULL,
	vector_id TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, vector_id)
);

CREATE INDEX idx_vector_embed_fingerprints_vector_id
ON vector_embed_fingerprints(vector_id);
