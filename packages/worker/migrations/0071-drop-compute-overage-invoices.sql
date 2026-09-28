-- Overage invoicing is retired (#2617). Nothing reads or writes the
-- leftover ledger, so drop the table (the status/month index goes with it).
DROP TABLE IF EXISTS compute_overage_invoices;
