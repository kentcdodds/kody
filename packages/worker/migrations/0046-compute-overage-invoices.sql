-- Monthly unique-worker-day and Durable Object rows-read overage ledger.
-- One row per user per UTC month. Status is the disposition (invoice,
-- soft_block, dry_run, skip_legacy) or failed. Stripe ids stay null on
-- non-invoice rows.

CREATE TABLE compute_overage_invoices (
	user_id TEXT NOT NULL,
	month TEXT NOT NULL,
	unique_worker_days INTEGER NOT NULL,
	unique_worker_day_cents INTEGER NOT NULL,
	durable_object_rows_read INTEGER NOT NULL,
	durable_object_rows_read_cents INTEGER NOT NULL,
	total_cents INTEGER NOT NULL,
	disposition TEXT NOT NULL,
	status TEXT NOT NULL,
	stripe_customer_id TEXT,
	stripe_invoice_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, month)
);

CREATE INDEX idx_compute_overage_invoices_status_month
	ON compute_overage_invoices (status, month);
