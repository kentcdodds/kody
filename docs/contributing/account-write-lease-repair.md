# Account write lease repair

Account write leases do not expire. A crashed writer intentionally blocks
account deletion until an administrator verifies that the process is gone and
releases its exact token with an audit reason.

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

The repair writes `account_write_lease_repairs` before releasing the token.
Wrong-user, stale timestamp, already-released token, or short reason requests
fail closed. Retry account deletion only after inspection shows no active
leases.
