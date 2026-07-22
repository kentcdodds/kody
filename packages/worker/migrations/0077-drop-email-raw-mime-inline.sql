-- Stage 4b2 (migration-only): drop transitional raw MIME inline storage after
-- production verified remainingInline=0, remainingBlockedInline=0,
-- remainingBlobCleanup=0 and code-only contraction (Stage 4b1) deployed healthy.
--
-- Fail-closed: any remaining inline raw_mime or cleanup-queue row aborts
-- (D1 rolls the transaction back). raw_mime_offload_blocked is not asserted
-- separately — unblocked inline rows are covered by the raw_mime check.
--
-- D1 supports ALTER TABLE DROP COLUMN in place; no table rebuild needed.

DROP INDEX IF EXISTS idx_email_messages_raw_mime_offload_unblocked;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'email_messages still has inline raw_mime rows; offload or delete before applying 0077.'
WHERE EXISTS (SELECT 1 FROM email_messages WHERE raw_mime IS NOT NULL);

INSERT INTO __migration_assertions (message)
SELECT 'email_raw_mime_cleanup_queue is not empty; drain the queue before applying 0077.'
WHERE EXISTS (SELECT 1 FROM email_raw_mime_cleanup_queue);

DROP TABLE __migration_assertions;

ALTER TABLE email_messages DROP COLUMN raw_mime;
ALTER TABLE email_messages DROP COLUMN raw_mime_offload_blocked;

DROP TABLE email_raw_mime_cleanup_queue;
