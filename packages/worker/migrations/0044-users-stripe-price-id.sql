-- Persist the Stripe price that currently grants `users.stripe_plan`.
-- Used to drop `legacy` when a subscriber changes price, product, or
-- interval (Standard↔Pro, month↔year, $29→$49). Same-plan auto-renew
-- keeps the previous price id and stays `legacy`. Null until the first
-- Stripe refresh after this migration; that first observation writes the
-- current price without treating the empty previous value as a change.

ALTER TABLE users ADD COLUMN stripe_price_id TEXT;
