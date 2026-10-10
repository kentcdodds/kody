-- Teams: indexes for the per-request org access lookups. Every table below
-- keyed its primary key by org or team first, so lookups by person
-- (memberships, team seats), pending-invite lookups by invitee and by org,
-- and handle lookups by org scanned. Additive only.

CREATE INDEX IF NOT EXISTS org_memberships_user_idx
	ON org_memberships (user_id);
CREATE INDEX IF NOT EXISTS team_members_user_idx
	ON team_members (user_id);
CREATE INDEX IF NOT EXISTS invites_org_status_idx
	ON invites (org_id, status, expires_at);
CREATE INDEX IF NOT EXISTS invites_invitee_email_idx
	ON invites (lower(COALESCE(invitee_email, '')));
CREATE INDEX IF NOT EXISTS invites_invitee_username_idx
	ON invites (lower(COALESCE(invitee_username, '')));
CREATE INDEX IF NOT EXISTS handles_org_idx
	ON handles (org_id);
