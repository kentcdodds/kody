-- Stage 6: drop dead email_inbox_addresses.reply_token_hash column.
-- Inbound routing no longer uses reply-token hashes; the reserved kody-r-
-- username prefix remains for collision avoidance only.
--
-- D1 supports ALTER TABLE DROP COLUMN in place; drop the dependent index first.

DROP INDEX IF EXISTS idx_email_inbox_addresses_reply_token;

ALTER TABLE email_inbox_addresses DROP COLUMN reply_token_hash;
