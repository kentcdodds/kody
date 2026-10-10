import * as childProcess from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { expect, test, vi } from 'vitest'
import {
	assertPreviewResourceName,
	buildPreviewResourceNames,
	cleanupPreviewResources,
	deletePreviewArtifactsNamespace,
	deletePreviewD1Database,
	deletePreviewKvNamespace,
	deletePreviewQueue,
	deletePreviewR2Bucket,
	deletePreviewVectorizeIndex,
	deletePreviewWorkerScript,
	previewResourceNamePattern,
	removePreviewQueueConsumers,
	resetPreviewD1Databases,
	type PreviewResourceKind,
} from './preview-resources.ts'
import { planPreviewOriginQueues } from './preview-queue-plan.ts'
import { parseJsonc } from './resource-utils.ts'

// Never launch a real wrangler from this suite: a guard regression must show
// up as an unexpected mock call, not as a Cloudflare API request.
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>()
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
	}
})

const spawnSync = vi.mocked(childProcess.spawnSync)

const wranglerCalls = () =>
	spawnSync.mock.calls.map((call) =>
		((call as [string, Array<string>])[1] ?? []).join(' '),
	)
const loggedMessages = () =>
	consoleError.mock.calls.map(([message]) => String(message))
const wranglerResult = (status: number, stderr = '', stdout = '') =>
	({ status, stdout, stderr }) as ReturnType<typeof childProcess.spawnSync>

function alreadyMissingWrangler(args: ReadonlyArray<string>) {
	const joined = args.join(' ')
	if (joined.includes('d1 list') || joined.includes('kv namespace list')) {
		return wranglerResult(0, '', '[]\n')
	}
	if (joined.startsWith('delete ') || joined.startsWith('r2 bucket delete ')) {
		return wranglerResult(1, 'Worker not found\n')
	}
	if (joined.includes('d1 delete') || joined.includes('kv namespace delete')) {
		return wranglerResult(1, 'does not exist\n')
	}
	return wranglerResult(1, `unexpected wrangler: ${joined}`)
}

function emptyQueueListResponse() {
	return Response.json({
		success: true,
		result: [],
		result_info: { total_pages: 1 },
	})
}

function stubCloudflare(
	fetchImpl: typeof fetch = async () => emptyQueueListResponse(),
) {
	vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account')
	vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token')
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(fetchImpl)
	vi.stubGlobal('fetch', fetchMock)
	return {
		fetchMock,
		[Symbol.dispose]: () => {
			vi.unstubAllGlobals()
			vi.unstubAllEnvs()
		},
	}
}

function authForbiddenResponse() {
	return Response.json(
		{
			success: false,
			errors: [{ code: 10000, message: 'Authentication error' }],
		},
		{ status: 403 },
	)
}

/** Fails the first wrangler call matching `when` with `stderr`, then succeeds. */
function failWranglerOnce(
	when: (argv: Array<string>) => boolean,
	stderr: string,
) {
	let attempts = 0
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (!when(argv)) return alreadyMissingWrangler(argv)
		attempts += 1
		return attempts === 1 ? wranglerResult(1, stderr) : wranglerResult(0)
	})
	return () => attempts
}

const cleanup = (workerName: string) =>
	cleanupPreviewResources({
		workerName,
		dryRun: false,
		sleep: async () => {},
	})

const wranglerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/jobs-worker/wrangler.jsonc',
	'packages/highlight-worker/wrangler.jsonc',
	'packages/status/wrangler.jsonc',
]

const resourceNameKeys = new Set([
	'name',
	'database_name',
	'bucket_name',
	'queue',
	'dead_letter_queue',
	'title',
	'script_name',
	'index_name',
	'service',
	'from_script',
])

function collectResourceNames(
	value: unknown,
	names = new Set<string>(),
): Set<string> {
	if (Array.isArray(value)) {
		for (const entry of value) collectResourceNames(entry, names)
		return names
	}
	if (!value || typeof value !== 'object') return names
	for (const [key, child] of Object.entries(value)) {
		if (resourceNameKeys.has(key) && typeof child === 'string') {
			names.add(child)
		}
		collectResourceNames(child, names)
	}
	return names
}

async function readCommittedResourceNames() {
	const names = new Set<string>()
	for (const configPath of wranglerConfigPaths) {
		const config = parseJsonc<unknown>(await readFile(configPath, 'utf8'))
		for (const name of collectResourceNames(config)) names.add(name)
	}
	return [...names]
}

const derivedProductionNames = [
	'kody',
	'kody-platform',
	'kody-runtime',
	'kody-jobs',
	'kody-db',
	'kody-production',
	'kody-production-backups',
	'kody-production-d1-backups',
	'kody-oauth',
	'kody-bundle-artifacts',
	'kody-email-delivery-events',
	'kody-artifacts-lifecycle-events',
	'kody-nx-cache',
]

const nonPreviewNames = [
	'',
	' ',
	'kody-pr-',
	'kody-pr-preview',
	'kody-pr-42x',
	'kody-pr-42-',
	'kody-pr-42--db',
	'kody-pr-42-DB',
	'kody-pr-42.db',
	'kody-branch-',
	'kody-branch-Feature',
	'kody-preview',
	'kody-preview-audit',
	'kody-preview-jobs',
	'kody-preview-webhook-dispatch',
	'kody-test-webhook-dispatch',
	'pr-42',
	'other-pr-42',
	'kody-pr-42\n',
	'kody\nkody-pr-42',
]

const acceptedWorkerNames = ['kody-pr-42', 'kody-branch-feature-x-y2']

function guardAccepts(name: string, kind: PreviewResourceKind) {
	try {
		assertPreviewResourceName(name, kind)
		return true
	} catch {
		return false
	}
}

function namesAcceptedByGuard(names: ReadonlyArray<string>) {
	return names.filter((name) => guardAccepts(name, 'worker'))
}

function namesRejectedByGuard(
	entries: ReadonlyArray<readonly [string, PreviewResourceKind]>,
) {
	return entries
		.filter(([name, kind]) => !guardAccepts(name, kind))
		.map(([name]) => name)
}

test('assertPreviewResourceName rejects committed production names and names outside the kody-pr / kody-branch scheme', async () => {
	const committed = await readCommittedResourceNames()
	expect(committed.length).toBeGreaterThan(20)
	expect(committed).toEqual(
		expect.arrayContaining([
			'kody',
			'kody-audit',
			'kody-community-assets',
			'kody-webhook-dispatch',
			'kody-scheduled-dispatch',
			'kody-preview-jobs',
			'kody-capabilities-prod',
			'kody-capabilities-preview',
		]),
	)
	expect(
		namesAcceptedByGuard([...committed, ...derivedProductionNames]),
	).toEqual([])
	expect(() => assertPreviewResourceName('kody', 'worker')).toThrow(
		'Refusing to delete worker "kody": it does not match the preview resource naming scheme',
	)
	expect(() => assertPreviewResourceName('kody-preview-jobs', 'd1')).toThrow(
		'Refusing to delete d1 "kody-preview-jobs"',
	)
	expect(() => assertPreviewResourceName('production', 'artifacts')).toThrow(
		'Refusing to delete artifacts "production"',
	)
	expect(() => assertPreviewResourceName('preview', 'artifacts')).toThrow(
		'Refusing to delete artifacts "preview"',
	)

	expect(
		nonPreviewNames.filter((name) => previewResourceNamePattern.test(name)),
	).toEqual([])
	expect(namesAcceptedByGuard(nonPreviewNames)).toEqual([])
	expect(() => assertPreviewResourceName('kody-pr-preview', 'd1')).toThrow(
		'Refusing to delete d1 "kody-pr-preview"',
	)
})

test('resetPreviewD1Databases deletes only per-PR app, audit, and jobs D1 names', async () => {
	consoleError.mockImplementation(() => {})
	spawnSync.mockReset()
	spawnSync.mockImplementation(() =>
		wranglerResult(0, '', JSON.stringify([{ name: 'kody-pr-99-db' }])),
	)

	await resetPreviewD1Databases({ workerName: 'kody-pr-99', dryRun: true })

	expect(loggedMessages()).toEqual(
		expect.arrayContaining([
			'[dry-run] delete D1 database: kody-pr-99-jobs-db',
			'[dry-run] delete D1 database: kody-pr-99-audit-db',
			'[dry-run] delete D1 database: kody-pr-99-db',
			expect.stringContaining('Preview D1 reset for kody-pr-99'),
		]),
	)
	await expect(
		resetPreviewD1Databases({ workerName: 'kody', dryRun: true }),
	).rejects.toThrow(/limited to kody-pr-<number>/)
	await expect(
		resetPreviewD1Databases({ workerName: 'kody-branch-feat', dryRun: true }),
	).rejects.toThrow(/limited to kody-pr-<number>/)
})

test('assertPreviewResourceName accepts every derived preview name kind, including 63-character truncation', () => {
	for (const workerName of acceptedWorkerNames) {
		const derived = buildPreviewResourceNames(workerName)
		const accepted: Array<[string, PreviewResourceKind]> = [
			[workerName, 'worker'],
			[`${workerName}-runtime`, 'worker'],
			[`${workerName}-platform`, 'worker'],
			[`${workerName}-jobs`, 'worker'],
			[`${workerName}-highlight`, 'worker'],
			[`${workerName}-api`, 'worker'],
			[`${workerName}-mock-cloudflare`, 'worker'],
			[derived.d1DatabaseName, 'd1'],
			[derived.auditD1DatabaseName, 'd1'],
			[derived.jobsD1DatabaseName, 'd1'],
			[derived.vectorizeIndexName, 'vectorize'],
			[derived.oauthKvTitle, 'kv'],
			[derived.bundleArtifactsKvTitle, 'kv'],
			[derived.communityAssetsBucketName, 'r2'],
			[derived.emailBlobsBucketName, 'r2'],
			[derived.repoSessionBlobsBucketName, 'r2'],
			[derived.webhookDispatchQueueName, 'queue'],
			[derived.webhookDispatchDeadLetterQueueName, 'queue'],
			[derived.artifactsNamespace, 'artifacts'],
		]
		expect(namesRejectedByGuard(accepted)).toEqual([])
		expect(derived.artifactsNamespace).toBe(workerName)
	}

	const longWorkerName = `kody-branch-${'a1'.repeat(15)}-z`
	expect(longWorkerName).toHaveLength(44)
	const derived = buildPreviewResourceNames(longWorkerName)
	expect(derived.bundleArtifactsKvTitle.length).toBeLessThanOrEqual(63)
	expect(derived.bundleArtifactsKvTitle).not.toContain(longWorkerName)
	expect(derived.bundleArtifactsKvTitle).toMatch(
		/^kody-branch-[a-z0-9]+-bundle-artifacts-kv$/,
	)
	expect(
		namesRejectedByGuard(
			Object.values(derived).map((name) => [name, 'kv'] as const),
		),
	).toEqual([])
})

test('cleanup and each guarded delete refuse production names before any wrangler or REST call', async () => {
	using cloudflare = stubCloudflare()
	for (const workerName of ['kody', 'kody-platform', 'kody-runtime', '']) {
		await expect(
			cleanupPreviewResources({ workerName, dryRun: false }),
		).rejects.toThrow('does not match the preview resource naming scheme')
	}
	await expect(
		cleanupPreviewResources({ workerName: 'kody', dryRun: true }),
	).rejects.toThrow('Refusing to delete worker "kody-api"')
	expect(consoleError).not.toHaveBeenCalled()

	const queueClient = {
		accountId: 'test-account',
		apiToken: 'test-token',
		dryRun: false,
	}
	const refusals: Array<[() => Promise<unknown>, string]> = [
		[
			() => deletePreviewWorkerScript({ name: 'kody-platform', dryRun: false }),
			'worker "kody-platform"',
		],
		[
			() => deletePreviewD1Database({ name: 'kody', dryRun: false }),
			'd1 "kody"',
		],
		[
			() => deletePreviewD1Database({ name: 'kody-audit', dryRun: false }),
			'd1 "kody-audit"',
		],
		[
			() => deletePreviewKvNamespace({ title: 'kody-oauth', dryRun: false }),
			'kv "kody-oauth"',
		],
		[
			() =>
				deletePreviewR2Bucket({ name: 'kody-community-assets', dryRun: false }),
			'r2 "kody-community-assets"',
		],
		[
			() =>
				deletePreviewQueue({ ...queueClient, name: 'kody-webhook-dispatch' }),
			'queue "kody-webhook-dispatch"',
		],
		[
			() =>
				removePreviewQueueConsumers({
					...queueClient,
					name: 'kody-email-delivery',
				}),
			'queue "kody-email-delivery"',
		],
		[
			() =>
				deletePreviewVectorizeIndex({
					...queueClient,
					name: 'kody-capabilities-prod',
				}),
			'vectorize "kody-capabilities-prod"',
		],
		[
			() =>
				deletePreviewVectorizeIndex({
					...queueClient,
					name: 'kody-capabilities-preview',
				}),
			'vectorize "kody-capabilities-preview"',
		],
		[
			() =>
				deletePreviewArtifactsNamespace({
					namespace: 'production',
					dryRun: false,
				}),
			'artifacts "production"',
		],
		[
			() =>
				deletePreviewArtifactsNamespace({
					namespace: 'preview',
					dryRun: false,
				}),
			'artifacts "preview"',
		],
	]
	for (const [attempt, target] of refusals) {
		await expect(attempt()).rejects.toThrow(`Refusing to delete ${target}`)
	}
	expect(spawnSync).not.toHaveBeenCalled()
	expect(cloudflare.fetchMock).not.toHaveBeenCalled()
})

test('dry-run cleanup of a PR preview walks every resource without Cloudflare credentials or calls', async () => {
	consoleError.mockImplementation(() => {})
	using cloudflare = stubCloudflare()
	vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', undefined)
	vi.stubEnv('CLOUDFLARE_API_TOKEN', undefined)
	await cleanupPreviewResources({ workerName: 'kody-pr-42', dryRun: true })
	const logged = loggedMessages()
	expect(logged).toEqual(
		expect.arrayContaining([
			'[dry-run] remove Queue consumers: kody-pr-42-webhook-dispatch',
			'[dry-run] remove Queue consumers: kody-pr-42-webhook-dispatch-dlq',
			'[dry-run] delete Worker script: kody-pr-42-api',
			'[dry-run] delete Worker script: kody-pr-42-runtime',
			'[dry-run] delete Worker script: kody-pr-42-platform',
			'[dry-run] delete Worker script: kody-pr-42',
			'[dry-run] delete Worker script: kody-pr-42-jobs',
			'[dry-run] delete Worker script: kody-pr-42-highlight',
			'[dry-run] delete Worker script: kody-pr-42-mock-cloudflare',
			'[dry-run] delete Queue: kody-pr-42-webhook-dispatch',
			'[dry-run] delete Queue: kody-pr-42-webhook-dispatch-dlq',
			'[dry-run] delete R2 bucket: kody-pr-42-community-assets',
			'[dry-run] delete R2 bucket: kody-pr-42-email-blobs',
			'[dry-run] delete R2 bucket: kody-pr-42-repo-session-blobs',
			'[dry-run] delete KV namespace: kody-pr-42-bundle-artifacts-kv',
			'[dry-run] delete KV namespace: kody-pr-42-oauth-kv',
			'[dry-run] delete D1 database: kody-pr-42-jobs-db',
			'[dry-run] delete D1 database: kody-pr-42-audit-db',
			'[dry-run] delete D1 database: kody-pr-42-db',
			'[dry-run] delete Vectorize index: kody-pr-42-vectors',
			'[dry-run] delete Artifacts namespace: kody-pr-42',
		]),
	)
	expect(logged.some((line) => line.includes('kody-preview-jobs'))).toBe(false)
	expect(
		logged.some((line) => line.includes('kody-capabilities-preview')),
	).toBe(false)
	expect(spawnSync).not.toHaveBeenCalled()
	expect(cloudflare.fetchMock).not.toHaveBeenCalled()
})

test('cleanup retries a wrangler 504 or 429 then continues later independent resources', async () => {
	consoleError.mockImplementation(() => {})
	using _cloudflare = stubCloudflare()
	const highlightAttempts = failWranglerOnce(
		(argv) => argv[0] === 'delete' && argv[1] === 'kody-pr-2017-highlight',
		'Gateway Timeout [code: 504]\n',
	)
	await cleanup('kody-pr-2017')
	expect(highlightAttempts()).toBe(2)
	const calls = wranglerCalls()
	expect(calls).toContain('delete kody-pr-2017-highlight --force')
	expect(calls).toContain('delete kody-pr-2017-mock-cloudflare --force')
	expect(calls.some((call) => call.startsWith('r2 bucket delete '))).toBe(true)
	expect(calls.some((call) => call.includes('d1 list'))).toBe(true)

	const runtimeAttempts = failWranglerOnce(
		(argv) => argv[0] === 'delete' && argv[1] === 'kody-pr-8-runtime',
		'Cloudflare API request failed (429): Rate limited\n',
	)
	await cleanup('kody-pr-8')
	expect(runtimeAttempts()).toBe(2)
})

test('D1 and KV deletes treat a post-retry not-found as success', async () => {
	consoleError.mockImplementation(() => {})
	using _cloudflare = stubCloudflare()
	const attempts = { d1: 0, kv: 0 }
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		const joined = argv.join(' ')
		if (joined.includes('d1 list')) {
			return wranglerResult(
				0,
				'',
				`${JSON.stringify([{ uuid: 'db-1', name: 'kody-pr-11-db' }])}\n`,
			)
		}
		if (joined.includes('kv namespace list')) {
			return wranglerResult(
				0,
				'',
				`${JSON.stringify([{ id: 'kv-1', title: 'kody-pr-11-oauth-kv' }])}\n`,
			)
		}
		const kind = joined.includes('d1 delete')
			? 'd1'
			: joined.includes('kv namespace delete')
				? 'kv'
				: null
		if (!kind) return alreadyMissingWrangler(argv)
		attempts[kind] += 1
		if (attempts[kind] === 1) {
			return wranglerResult(1, 'Gateway Timeout [code: 504]\n')
		}
		return wranglerResult(
			1,
			kind === 'd1'
				? 'The database you tried to delete does not exist\n'
				: 'The requested resource does not exist\n',
		)
	})

	await cleanup('kody-pr-11')
	expect(attempts).toEqual({ d1: 2, kv: 2 })
	expect(loggedMessages()).toEqual(
		expect.arrayContaining([
			'D1 database already deleted: kody-pr-11-db',
			'KV namespace already deleted: kody-pr-11-oauth-kv',
		]),
	)
})

test('permanent queue auth failure still attempts later independent resources and aggregates leftovers', async () => {
	consoleError.mockImplementation(() => {})
	using cloudflare = stubCloudflare(async (input) =>
		String(input).includes('/r2/buckets/')
			? emptyQueueListResponse()
			: authForbiddenResponse(),
	)
	const attemptedWorkers: Array<string> = []
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'delete') {
			attemptedWorkers.push(argv[1] ?? '')
			if (argv[1] === 'kody-pr-1999-highlight') {
				return wranglerResult(1, 'Authentication error [code: 10000]\n')
			}
		}
		return alreadyMissingWrangler(argv)
	})

	const queueCount = planPreviewOriginQueues('kody-pr-1999').queueNames.length
	// Each queue fails twice (consumers, then the queue itself), plus the
	// highlight worker, the Vectorize index, and the Artifacts namespace.
	await expect(cleanup('kody-pr-1999')).rejects.toThrow(
		new RegExp(
			`Preview cleanup failed for ${String(queueCount * 2 + 3)} resource\\(s\\)`,
		),
	)
	expect(
		attemptedWorkers.filter((name) => name === 'kody-pr-1999-highlight'),
	).toEqual(['kody-pr-1999-highlight'])
	expect(attemptedWorkers).toEqual(
		expect.arrayContaining(
			[
				'-api',
				'-runtime',
				'-platform',
				'',
				'-jobs',
				'-highlight',
				'-mock-cloudflare',
			].map((suffix) => `kody-pr-1999${suffix}`),
		),
	)
	const calls = wranglerCalls()
	expect(calls.some((call) => call.startsWith('r2 bucket delete '))).toBe(true)
	expect(calls).toContain('d1 list --json')
	expect(calls).toContain('kv namespace list')
	expect(cloudflare.fetchMock).toHaveBeenCalled()
})

test('already-missing preview resources are successful and idempotent', async () => {
	consoleError.mockImplementation(() => {})
	using _cloudflare = stubCloudflare()
	spawnSync.mockImplementation((_command, args) =>
		alreadyMissingWrangler(args as Array<string>),
	)
	await cleanup('kody-pr-42')
	expect(loggedMessages()).toEqual(
		expect.arrayContaining([
			'Queue already deleted (no consumers to remove): kody-pr-42-webhook-dispatch',
			'Worker script already deleted: kody-pr-42',
			'Queue already deleted: kody-pr-42-webhook-dispatch',
			'R2 bucket already deleted: kody-pr-42-community-assets',
			'D1 database already deleted: kody-pr-42-db',
			'KV namespace already deleted: kody-pr-42-oauth-kv',
			'Deleted Artifacts namespace: kody-pr-42',
		]),
	)
})

test('cleanup preserves queue-consumer then worker then queue order', async () => {
	consoleError.mockImplementation(() => {})
	const events: Array<string> = []
	using _cloudflare = stubCloudflare(async (input) => {
		if (String(input).includes('/queues?')) events.push('list-queues')
		return emptyQueueListResponse()
	})
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'delete') events.push(`delete-worker ${argv[1]}`)
		if (argv[0] === 'r2') events.push(`delete-r2 ${argv[3]}`)
		if (argv[0] === 'd1' && argv[1] === 'list') events.push('list-d1')
		return alreadyMissingWrangler(argv)
	})

	await cleanup('kody-pr-9')
	const firstWorker = events.indexOf('delete-worker kody-pr-9-runtime')
	const firstQueueList = events.indexOf('list-queues')
	const firstR2 = events.findIndex((event) => event.startsWith('delete-r2 '))
	expect(firstQueueList).toBeGreaterThanOrEqual(0)
	expect(firstWorker).toBeGreaterThan(firstQueueList)
	expect(firstR2).toBeGreaterThan(firstWorker)
	expect(events.filter((event) => event === 'list-queues').length).toBe(
		planPreviewOriginQueues('kody-pr-9').queueNames.length * 2,
	)
})

test('non-empty preview R2 buckets are emptied then deleted', async () => {
	consoleError.mockImplementation(() => {})
	const deletedObjectUrls: Array<string> = []
	using _cloudflare = stubCloudflare(async (input, init) => {
		const url = String(input)
		if (!url.includes('/r2/buckets/') || !url.includes('/objects')) {
			return emptyQueueListResponse()
		}
		if ((init?.method ?? 'GET') === 'DELETE') {
			deletedObjectUrls.push(url)
			return Response.json({ success: true, result: null })
		}
		return Response.json({
			success: true,
			result: [{ key: 'seeded/blob.bin' }],
			result_info: { total_pages: 1 },
		})
	})
	const emailBlobDeletes = failWranglerOnce(
		(argv) =>
			argv.slice(0, 4).join(' ') === 'r2 bucket delete kody-pr-42-email-blobs',
		'The bucket you tried to delete is not empty\n',
	)

	await cleanup('kody-pr-42')
	expect(emailBlobDeletes()).toBe(2)
	expect(
		deletedObjectUrls.some((url) => url.includes('/objects/seeded/blob.bin')),
	).toBe(true)
	expect(deletedObjectUrls.some((url) => url.includes('%2F'))).toBe(false)
	expect(loggedMessages()).toEqual(
		expect.arrayContaining([
			'Deleted R2 object: kody-pr-42-email-blobs/seeded/blob.bin',
			'Deleted R2 bucket: kody-pr-42-email-blobs',
		]),
	)
})
