# Legacy D1 export (for migration)

Use this when you need a **local copy** of a remote D1 database to inspect data
or copy selected tables into a **new** kody-owned D1 after fixing Wrangler
resource IDs.

## Export remote D1 → local SQLite

From the repo root, with `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`)
set in `packages/worker/.env`:

```bash
chmod +x ./tools/export-d1-remote-to-sqlite.sh
./tools/export-d1-remote-to-sqlite.sh epicflare
```

This writes (under `.tmp/`, which is gitignored):

- `.tmp/d1-exports/epicflare.sql` — full SQL dump from Cloudflare
- `.tmp/d1-exports/epicflare.sqlite` — same content as a local SQLite file you
  can open in any SQLite client

Override the output directory:

```bash
D1_EXPORT_DIR=./my-exports ./tools/export-d1-remote-to-sqlite.sh epicflare-preview
```

## What we learned about the old “kody” bindings

The previously checked-in `database_id` values pointed at D1 databases named
**`epicflare`** and **`epicflare-preview`**, not `kody` / `kody-preview`. The
production DB (`epicflare`) contains both:

- **kody / epicflare-shared app tables** (see `migrations/`): `users`,
  `password_resets`, `chat_threads`, `mcp_skills`, `mock_resend_messages`,
  `mock_ai_requests`
- **Older epicflare-only tables** (not in current kody migrations): e.g.
  `accounts`, `households`, `kids`, `transactions`, `quick_amount_presets`,
  `agents`

For a clean kody database, you typically **migrate** only the first group (and
only the rows you care about).

## Copying into a new D1

1. Create or ensure the new D1 + apply migrations on the **target** (empty)
   database (production CI does this).
2. Do **not** blindly restore the whole `.sql` file into the new DB — it would
   recreate legacy tables you do not want.
3. Prefer **attaching** the legacy SQLite and inserting per table:

```sql
-- Run with: sqlite3 target.sqlite
ATTACH 'epicflare.sqlite' AS legacy;

-- Example: copy users (adjust column lists if schemas diverged)
INSERT INTO users SELECT * FROM legacy.users;

-- Repeat for other tables you approved: password_resets, chat_threads,
-- mcp_skills, mock_*, etc. Watch foreign key order (users before children).
```

4. Re-export from local `target.sqlite` or use `wrangler d1 execute` with SQL
   files against the **remote** new database, or use a small scripted import —
   whatever fits your cutover process.

## OAuth KV

`OAUTH_KV` is separate from D1. A fresh namespace is normal; do not bulk-copy
OAuth KV unless you have a specific reason (tokens and client registrations will
repopulate on use).

## Security

Do not commit `.sqlite` / `.sql` dumps if they contain personal data. Keep them
under `.tmp/` or another ignored path.
