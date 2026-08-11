import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	createD1JobsStore,
	type JobsStore,
} from '../packages/shared/src/jobs/store.ts'
// Bundled as text by tools/build-jobs-test-service.ts (esbuild `.sql` loader).
import jobsInitSql from '../packages/jobs-worker/migrations/0001-jobs-init.sql'

/**
 * Auxiliary worker for the workers-unit vitest pool: the main worker's test
 * env binds JOBS to "kody-jobs-test" (ADR 0016), which local `wrangler dev`
 * resolves from the real jobs-worker config. The vitest pool only loads the
 * main worker config, so this bundle serves the JobsService contract from the
 * shared D1 jobs store against its own JOBS_DB (schema applied lazily from
 * the real jobs-worker migration).
 */

type StubEnv = { JOBS_DB: D1Database }

const schemaStatements = jobsInitSql
	.split('\n')
	.filter((line) => !line.trim().startsWith('--'))
	.join('\n')
	.split(';')
	.map((statement) => statement.trim())
	.filter((statement) => statement.length > 0)

// Runs on every call (not memoized): the pool's isolated storage can reset
// the aux worker's D1 between tests while module state survives.
async function ensureSchema(db: D1Database) {
	for (const statement of schemaStatements) {
		try {
			await db.prepare(statement).run()
		} catch (error) {
			if (!String(error).includes('already exists')) throw error
		}
	}
}

const storeMethodNames = [
	'insertJob',
	'updateJob',
	'getJobById',
	'listJobsForUser',
	'listJobsPage',
	'listDueJobs',
	'getNextRunnableJob',
	'claimJob',
	'finalizeClaimedJob',
	'retryClaimedJob',
	'refreshPackageJobIdentity',
	'deleteJob',
	'disableExpiredJobsForUser',
	'listJobRetentionCandidates',
	'upsertArchivedJobArtifact',
	'listArchivedJobArtifactsDueBefore',
	'deleteArchivedJobArtifact',
	'countJobsForUser',
	'sumJobsStorageBytesForUser',
	'listJobStorageIdsForUser',
	'listArchivedJobArtifactsForUser',
	'listAllJobStorageOwners',
	'getJobInsights',
	'purgeUserJobsData',
] satisfies Array<keyof JobsStore>

class JobsService extends WorkerEntrypoint<StubEnv> {
	async syncAlarm(_input: { userId: string }) {}

	async purgeUser(input: { userId: string }) {
		await ensureSchema(this.env.JOBS_DB)
		await createD1JobsStore(this.env.JOBS_DB).purgeUserJobsData(input)
		return { ok: true as const, userId: input.userId, purged: true }
	}
}

for (const name of storeMethodNames) {
	Object.defineProperty(JobsService.prototype, name, {
		value: async function (this: JobsService, input: never) {
			const env = (this as unknown as { env: StubEnv }).env
			await ensureSchema(env.JOBS_DB)
			const store = createD1JobsStore(env.JOBS_DB)
			return await (store[name] as (input: never) => Promise<unknown>)(input)
		},
		writable: true,
		configurable: true,
	})
}

export { JobsService }

export default {
	fetch() {
		return new Response('jobs test service', { status: 404 })
	},
}
