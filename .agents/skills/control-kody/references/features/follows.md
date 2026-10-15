# Follows

A workspace follows a package or plain repo to receive `follow.published` (new
versions) and `follow.pushed` (default-branch pushes) events. Each follow is its
own record with its own event choice. The org is always the one in the URL.

## How to get there

- Package or repo page `/@<owner>/<kodyId>` → **Follow** in the repository
  action group opens the Follow panel on the Repo tab. Other tabs link to
  `/@<owner>/<kodyId>#follow`, which opens it on load. Signed-out visitors get a
  sign-in link back to the Repo tab.
- `/@<slug>/-/follows` (workspace rail → Build → Follows) lists the workspace's
  follows with status, pause reason, deletion date for paused rows, Resume, and
  Unfollow. Follow ids live in each row's collapsed **Details**.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /profiles/<owner>/packages/<kodyId>/follow.json
node tools/control-kody.ts request POST /@<slug>/-/follows.json \
  --json '{"intent":"follow","name":"@<owner>/<kodyId>","kind":"package","events":["published"]}'
node tools/control-kody.ts request GET /@<slug>/-/follows.json
node tools/control-kody.ts request POST /@<slug>/-/follows.json \
  --json '{"intent":"unfollow","name":"@<owner>/<kodyId>","kind":"package"}'
```

## APIs

- `GET /profiles/:username/packages/:kodyId/follow.json[?kind=package|repo]` —
  `{ ok, target, availableEvents, canPush, workspaces[] }`. Each workspace is
  one the viewer is a member of (personal first) with its `follow` summary or
  null. A target the viewer cannot follow is a 404, like a missing one.
- `GET /@:orgSlug/-/follows.json` — `{ ok, orgSlug, follows[] }`; `org:read`.
- `POST /@:orgSlug/-/follows.json` — `{ intent: 'follow', name, kind, events? }`
  creates, resumes, or changes events (omit `events` to keep the stored choice);
  `{ intent: 'unfollow', id }` or `{ intent: 'unfollow', name, kind }` deletes.
  Errors carry `code`: `invalid` 400, `unauthorized` 401, `not_found` 404,
  `rate_limited` 429.

## Gotchas

- Pushes need `package:read` on the package (org-wide for plain repos), even for
  public targets. A Use grant qualifies; run-only access does not. The panel
  disables the Pushes checkbox and says why. Plain repos only send pushes, so a
  repo without read access cannot be followed from the web.
- New follows are limited to 30 per workspace per hour. Changing events,
  resuming, and unfollowing do not use a slot.
- Seed users own no packages. Insert a public `user_repos` row for the seed user
  (see `e2e/follows.spec.ts`) to exercise the owner flow.
- Paused follows are deleted 30 days after `paused_at`. Pause reasons are
  `target_missing` and `access_lost`.
