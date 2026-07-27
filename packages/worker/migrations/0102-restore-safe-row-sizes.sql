-- D1's SQL import path rejects statements above its ~100 KB statement-length
-- limit (statement too long: SQLITE_TOOBIG). D1 exports write one INSERT per
-- row, so any row whose serialized form exceeds that limit makes the whole
-- production backup un-importable — verified live 2026-07-27 with restore
-- drills of the 2026-07-26 production export. Bound the two write paths that
-- had already produced oversized rows (write-time caps now enforce this in
-- packages/worker/src/package-invocations/repo.ts and email/repo.ts):
--
-- 1. package_invocations.response_json is an idempotency replay cache.
--    Dropping it keeps deduplication intact; replays of affected invocations
--    get the existing idempotency_response_unavailable outcome.
UPDATE package_invocations
SET response_json = NULL
WHERE response_json IS NOT NULL
	AND LENGTH(CAST(response_json AS BLOB)) > 65536;

-- 2. email_messages body columns are convenience copies; the canonical full
--    message stays in the R2 raw MIME object referenced by raw_mime_key.
--    substr counts characters, so 16000 keeps even fully multibyte content
--    under the 65536-byte column bound.
UPDATE email_messages
SET text_body = substr(text_body, 1, 16000) || '
[truncated for backup-safe storage; the full message is retained in the raw MIME object]'
WHERE text_body IS NOT NULL
	AND LENGTH(CAST(text_body AS BLOB)) > 65536;

UPDATE email_messages
SET html_body = substr(html_body, 1, 16000) || '
[truncated for backup-safe storage; the full message is retained in the raw MIME object]'
WHERE html_body IS NOT NULL
	AND LENGTH(CAST(html_body AS BLOB)) > 65536;
