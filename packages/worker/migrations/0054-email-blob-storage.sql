-- Move raw email MIME out of D1: a message may now store an R2 object key
-- (EMAIL_BLOBS bucket, `email-raw:v1:{userId}/{messageId}`) instead of the
-- inline raw_mime payload. Additive only; legacy rows keep raw_mime inline.
ALTER TABLE email_messages ADD COLUMN raw_mime_key TEXT;
