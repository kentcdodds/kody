-- The 'personal' tier was removed in favor of a single paid tier ('pro').
-- parsePlanName treats unknown stored values as NULL (legacy/unlimited), so
-- without this migration any account granted 'personal' would silently lose
-- enforcement. Map every stored 'personal' to 'pro' (a strict upgrade).
UPDATE users SET plan = 'pro' WHERE plan = 'personal';
UPDATE users SET stripe_plan = 'pro' WHERE stripe_plan = 'personal';
UPDATE invites SET plan = 'pro' WHERE plan = 'personal';
