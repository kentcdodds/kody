# Account write lease repair

Account write leases do not expire. A crashed writer intentionally blocks
account deletion until an administrator verifies that the process is gone and
releases its exact token with an audit reason.

Active leases live in the UserMeter DO. All callers supply `env` (including
email paths), so every lease is a UserMeter-authoritative row. Migration `0141`
dropped D1 `account_write_leases`; `account_write_lease_repairs` remains the D1
audit log for all repairs.

First inspect active leases:

```javascript
await kody.admin_account_write_lease_list({
	stable_user_id: 'user-id-from-admin-account-lookup',
})
```

Review the returned token, holder, and `acquired_at` timestamp against runtime
logs before repair. Then release exactly that inspected lease:

```javascript
await kody.admin_account_write_lease_repair({
	stable_user_id: 'user-id-from-admin-account-lookup',
	token: '00000000-0000-4000-8000-000000000000',
	expected_acquired_at: '2026-07-23 05:00:00',
	reason: 'Confirmed worker invocation terminated; no process remains.',
})
```

The repair writes an `account_write_lease_repairs` audit row before releasing
the token. Repair uses the DO-only path: prepare (stable `repairId`, lease stays
held) → audit insert/verify → finalize DO deletion. Retries after a lost
finalize response succeed when the matching audit exists and the DO lease is
already gone. Wrong user, stale timestamp, or short reason requests fail closed.
Retry account deletion only after inspection shows no active leases.
