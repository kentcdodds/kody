# Account write lease repair

Account write leases do not expire. A crashed writer intentionally blocks
account deletion until an administrator verifies that the process is gone and
releases its exact token with an audit reason.

Active leases live in the UserMeter DO (`authority='do'`) and/or in D1
(`account_write_leases`) as legacy email leases or historical stale rows from
before the temporary D1 mirror was retired (2026-08-01). Admin list unions both,
deduped by token.

**Temporary D1 mirror retired (2026-08-01):** DO-authority callers (those that
supply `USER_METER`) no longer insert a D1 row on acquire. D1
`account_write_leases` rows now represent:

- **Legacy email leases** — callers that omit `env` still take the exact D1
  path.
- **Historical stale rows** — pre-retirement mirrors that were not cleaned up
  before the deploy. Use `admin_account_write_lease_repair` to clear these via
  the audited repair path; do not delete rows directly from D1.

D1 columns and the `account_write_leases` table are **retained** — no schema
drop is planned yet.

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

The repair writes `account_write_lease_repairs` before releasing the token. D1
leases (legacy email) use an atomic audit-before-delete batch. DO-authority
leases use prepare (stable `repairId`, lease stays held) → audit insert/verify →
finalize DO deletion → clear any stale D1 row. A stale D1 row is never cleared
while the DO lease remains held. Retries after a lost finalize response succeed
when the matching audit exists and the DO lease is already gone (idempotently
clearing any stale D1 row). Wrong user, stale timestamp, or short reason
requests fail closed. Retry account deletion only after inspection shows no
active leases.
