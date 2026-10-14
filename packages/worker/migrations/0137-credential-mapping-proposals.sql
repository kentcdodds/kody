-- Agent credential mapping proposals (ADR 0068 amendment 2026-10-13, "How
-- picks change"). credentialMappingPropose records each proposal under the
-- agent that made it: the person it acted for plus the request credential
-- (an MCP OAuth client, CLI client, or API token). When that person approves
-- the proposal's link, approved_picks_json records the trigger picks they
-- approved, as credential ids. credentialTriggerPickSet lets the same agent
-- set a trigger pick back to one of those values, and nothing else.

CREATE TABLE credential_mapping_proposals (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	person_user_id TEXT NOT NULL,
	agent_credential_kind TEXT NOT NULL
		CHECK (agent_credential_kind IN ('mcp-oauth', 'cli', 'api-token')),
	agent_credential_id TEXT NOT NULL,
	proposal_json TEXT NOT NULL,
	approved_picks_json TEXT,
	approved_at TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX credential_mapping_proposals_agent_idx
	ON credential_mapping_proposals (
		org_id, package_id, person_user_id, agent_credential_kind,
		agent_credential_id
	);

CREATE INDEX credential_mapping_proposals_person_user_idx
	ON credential_mapping_proposals (person_user_id);
