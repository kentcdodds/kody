# Example job: feed checker with incremental state

This example shows a scheduled job that remembers the latest seen item id in its
facet SQLite storage and only emits new items on later runs.

## Save it

Create the job with `job_create`:

```json
{
	"name": "Feed checker",
	"schedule": {
		"intervalMs": 3600000
	},
	"timezone": "America/Denver",
	"enabled": true,
	"serverCode": "import { DurableObject } from 'cloudflare:workers'\n\nexport class Job extends DurableObject {\n\tasync run() {\n\t\tconst feedUrlValue = await KODY.valueGet('feed_url', 'user')\n\t\tif (!feedUrlValue?.value) {\n\t\t\tthrow new Error('Missing persisted value \"feed_url\".')\n\t\t}\n\n\t\tconst response = await KODY.fetchViaHostGateway({\n\t\t\turl: feedUrlValue.value,\n\t\t\tmethod: 'GET',\n\t\t\theaders: {\n\t\t\t\tAccept: 'application/json',\n\t\t\t},\n\t\t})\n\t\tif (response.status >= 400) {\n\t\t\tthrow new Error(`Feed request failed: ${response.status} ${response.statusText}`)\n\t\t}\n\n\t\tconst payload = JSON.parse(response.body)\n\t\tconst items = Array.isArray(payload.items) ? payload.items : []\n\t\tconst latestSeen = this.ctx.storage.sql\n\t\t\t.exec('SELECT item_id FROM feed_state WHERE singleton = 1')\n\t\t\t.one<{ item_id?: string }>()?.item_id ?? null\n\n\t\tthis.ctx.storage.sql.exec(\n\t\t\t'CREATE TABLE IF NOT EXISTS feed_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), item_id TEXT)',\n\t\t)\n\n\t\tconst freshItems = latestSeen\n\t\t\t? items.filter((item) => item?.id && item.id !== latestSeen)\n\t\t\t: items.slice(0, 1)\n\n\t\tif (items[0]?.id) {\n\t\t\tthis.ctx.storage.sql.exec(\n\t\t\t\t'INSERT INTO feed_state (singleton, item_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET item_id = excluded.item_id',\n\t\t\t\tString(items[0].id),\n\t\t\t)\n\t\t}\n\n\t\tif (freshItems.length === 0) {\n\t\t\treturn { newItems: 0 }\n\t\t}\n\n\t\treturn {\n\t\t\tnewItems: freshItems.length,\n\t\t\tlatestItemId: String(items[0]?.id ?? ''),\n\t\t\tnotifications: freshItems.map((item) => ({\n\t\t\t\tid: String(item.id),\n\t\t\t\ttitle: String(item.title ?? item.id),\n\t\t\t})),\n\t\t}\n\t}\n}\n"
}
```

## Notes

- The job uses `KODY.valueGet('feed_url', 'user')` so the feed URL can be
  changed without editing code.
- `KODY.fetchViaHostGateway()` uses the same secret-aware host approval path as
  execute-time fetch.
- The `feed_state` table is local to the job facet, so every job keeps its own
  checkpoint independently.
- Inspect the latest outcomes with `job_history({ job_id })`.
