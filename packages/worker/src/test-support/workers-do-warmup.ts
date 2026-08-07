import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'

/**
 * Workers-unit setupFiles import. Forces the Vitest pool to load the Durable
 * Object classes that dominate cold-start cost (Mailbox, UserMeter, RunLog)
 * once per Worker module cache.
 *
 * `globalSetup` cannot do this — it runs in Node, not workerd. `setupFiles`
 * re-runs before every test file, but this module's top-level await is cached
 * with the Worker, so later files on the same Worker pay ~20ms instead of
 * ~10s. Test bodies then see ~1–10ms first RPCs instead of timing out.
 *
 * Suite wall clock stays similar (the cold load still happens); it just moves
 * out of `testTimeout` and into setup.
 */
const mailboxId = env.MAILBOX.idFromName('__vitest-do-warmup-mailbox__')
await runInDurableObject(env.MAILBOX.get(mailboxId), async () => 'warm')

const userMeterId = env.USER_METER.idFromName('__vitest-do-warmup-meter__')
await runInDurableObject(env.USER_METER.get(userMeterId), async () => 'warm')

const runLogId = env.RUN_LOG.idFromName('__vitest-do-warmup-run-log__')
await runInDurableObject(env.RUN_LOG.get(runLogId), async () => 'warm')
