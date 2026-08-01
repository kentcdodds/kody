-- Stage 3 (migration-only): drop the quiescent entitlement_daily_counters D1
-- mirror after Worker #1133 stopped mirror writes and #1134 detached runtime
-- account export/deletion inventory. Authoritative daily counters live in the
-- per-user UserMeter Durable Object; admin_user_meter_parity reports
-- daily.mirrorRetired: true once this table is absent.

DROP INDEX IF EXISTS idx_entitlement_daily_counters_day;
DROP TABLE IF EXISTS entitlement_daily_counters;
