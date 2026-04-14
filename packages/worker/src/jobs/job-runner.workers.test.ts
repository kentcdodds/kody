import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { configureJobRunner, jobRunnerRpc, JobRunner } from './job-runner.ts'

test('facet job runner preserves isolated sqlite state per job', async () => {
	await configureJobRunner({
		env,
		jobId: 'facet-job-a',
		userId: 'user-123',
		baseUrl: 'https://example.com',
		storageContext: {
			appId: 'facet-job-a',
			sessionId: null,
		},
		serverCode: `
import { DurableObject } from 'cloudflare:workers'

export class Job extends DurableObject {
	async run(input = {}) {
		const previous = (await this.ctx.storage.get('counter')) ?? 0
		const nextCount = Number(previous) + 1
		await this.ctx.storage.put('counter', nextCount)
		return {
			count: nextCount,
			echo: input.echo ?? null,
		}
	}

	constructor(ctx, env) {
		super(ctx, env)
	}
}
		`.trim(),
		serverCodeId: 'facet-job-a-code',
		methodName: 'run',
	})
	await configureJobRunner({
		env,
		jobId: 'facet-job-b',
		userId: 'user-123',
		baseUrl: 'https://example.com',
		storageContext: {
			appId: 'facet-job-b',
			sessionId: null,
		},
		serverCode: `
import { DurableObject } from 'cloudflare:workers'

export class Job extends DurableObject {
	async run() {
		const previous = (await this.ctx.storage.get('counter')) ?? 0
		const nextCount = Number(previous) + 1
		await this.ctx.storage.put('counter', nextCount)
		return { count: nextCount }
	}

	constructor(ctx, env) {
		super(ctx, env)
	}
}
		`.trim(),
		serverCodeId: 'facet-job-b-code',
		methodName: 'run',
	})

	const runnerA = jobRunnerRpc(env, 'facet-job-a')
	const runnerB = jobRunnerRpc(env, 'facet-job-b')

	await expect(
		runnerA.runStoredJob({
			jobId: 'facet-job-a',
			params: { echo: 'first' },
		}),
	).resolves.toMatchObject({
		result: {
			count: 1,
			echo: 'first',
		},
	})
	await expect(
		runnerA.runStoredJob({
			jobId: 'facet-job-a',
		}),
	).resolves.toMatchObject({
		result: {
			count: 2,
		},
	})
	await expect(
		runnerB.runStoredJob({
			jobId: 'facet-job-b',
		}),
	).resolves.toMatchObject({
		result: {
			count: 1,
		},
	})

	const stubA = env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName('facet-job-a'))
	await runInDurableObject(stubA, async (instance: JobRunner, state) => {
		expect(instance).toBeInstanceOf(JobRunner)
		expect(state.storage.sql.databaseSize).toBeGreaterThan(0)
	})

	await expect(
		runnerA.exportStorage({
			jobId: 'facet-job-a',
		}),
	).resolves.toMatchObject({
		export: {
			entries: [
				{
					key: 'counter',
					value: 2,
				},
			],
		},
	})
	await expect(
		runnerB.exportStorage({
			jobId: 'facet-job-b',
		}),
	).resolves.toMatchObject({
		export: {
			entries: [
				{
					key: 'counter',
					value: 1,
				},
			],
		},
	})
})

test('deleteJob removes non-default registered facets', async () => {
	await configureJobRunner({
		env,
		jobId: 'facet-job-delete',
		userId: 'user-123',
		baseUrl: 'https://example.com',
		storageContext: {
			appId: 'facet-job-delete',
			sessionId: null,
		},
		serverCode: `
import { DurableObject } from 'cloudflare:workers'

export class Job extends DurableObject {
	async run(input = {}) {
		const key = String(input.key ?? 'counter')
		const previous = (await this.ctx.storage.get(key)) ?? 0
		const nextCount = Number(previous) + 1
		await this.ctx.storage.put(key, nextCount)
		return { key, count: nextCount }
	}

	constructor(ctx, env) {
		super(ctx, env)
	}
}
		`.trim(),
		serverCodeId: 'facet-job-delete-code',
		methodName: 'run',
	})

	const runner = jobRunnerRpc(env, 'facet-job-delete')
	await expect(
		runner.runStoredJob({
			jobId: 'facet-job-delete',
			facetName: 'secondary',
			params: { key: 'secondary-counter' },
		}),
	).resolves.toMatchObject({
		result: {
			key: 'secondary-counter',
			count: 1,
		},
	})

	await expect(
		runner.exportStorage({
			jobId: 'facet-job-delete',
			facetName: 'secondary',
		}),
	).resolves.toMatchObject({
		export: {
			entries: [
				{
					key: 'secondary-counter',
					value: 1,
				},
			],
		},
	})

	await expect(
		runner.deleteJob({
			jobId: 'facet-job-delete',
		}),
	).resolves.toEqual({
		ok: true,
		jobId: 'facet-job-delete',
	})

	await configureJobRunner({
		env,
		jobId: 'facet-job-delete',
		userId: 'user-123',
		baseUrl: 'https://example.com',
		storageContext: {
			appId: 'facet-job-delete',
			sessionId: null,
		},
		serverCode: `
import { DurableObject } from 'cloudflare:workers'

export class Job extends DurableObject {
	async run(input = {}) {
		const key = String(input.key ?? 'counter')
		const previous = (await this.ctx.storage.get(key)) ?? 0
		const nextCount = Number(previous) + 1
		await this.ctx.storage.put(key, nextCount)
		return { key, count: nextCount }
	}

	constructor(ctx, env) {
		super(ctx, env)
	}
}
		`.trim(),
		serverCodeId: 'facet-job-delete-code-2',
		methodName: 'run',
	})

	await expect(
		runner.runStoredJob({
			jobId: 'facet-job-delete',
			facetName: 'secondary',
			params: { key: 'secondary-counter' },
		}),
	).resolves.toMatchObject({
		result: {
			key: 'secondary-counter',
			count: 1,
		},
	})
})
