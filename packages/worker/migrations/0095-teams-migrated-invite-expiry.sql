-- Teams: invites converted from pending package shares in 0091 were given a
-- 30-day window from migration time. New invites expire 7 days after they are
-- sent, and converted invites follow the same policy: 7 days from the share's
-- original invited_at (their created_at). Rows already past that point are
-- simply expired (the readers filter on expires_at), the same as any new
-- invite that ran out. Idempotent: only pending converted invites whose
-- window is still longer than 7 days are touched.

UPDATE invites
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days')
WHERE id LIKE 'p8-share-%'
	AND status = 'pending'
	AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days');
