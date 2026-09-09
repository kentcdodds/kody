-- Store the minted URL secret encrypted so webhookUrlApply (and website-only
-- reveal) can consume it without returning the credential to the model.
ALTER TABLE webhook_endpoints ADD COLUMN url_secret_encrypted TEXT;
