import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'

/**
 * Workers-unit setupFiles import (decision 0011). Loads Mailbox, UserMeter, and
 * RunLog once per Worker module cache via `runInDurableObject`.
 *
 * Do not replace this with `globalSetup` (Node-only) or `--no-isolate` (shared
 * storage breaks per-file suites). See docs/contributing/testing-principles.md.
 */
const mailboxId = env.MAILBOX.idFromName('__vitest-do-warmup-mailbox__')
await runInDurableObject(env.MAILBOX.get(mailboxId), async () => 'warm')

const userMeterId = env.USER_METER.idFromName('__vitest-do-warmup-meter__')
await runInDurableObject(env.USER_METER.get(userMeterId), async () => 'warm')

const runLogId = env.RUN_LOG.idFromName('__vitest-do-warmup-run-log__')
await runInDurableObject(env.RUN_LOG.get(runLogId), async () => 'warm')
