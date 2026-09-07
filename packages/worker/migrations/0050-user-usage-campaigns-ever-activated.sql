-- Remember activation so LimitAware / Paid cannot erase it. Once a user has
-- been Activated, Cooling, or Paid, they must not fall back to packaged
-- onboarding mail after a later client-count or execute-depth dip.

ALTER TABLE user_usage_campaigns
	ADD COLUMN ever_activated INTEGER NOT NULL DEFAULT 0;
