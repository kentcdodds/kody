import * as childProcess from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { expect, test, vi } from 'vitest'
import {
	assertPreviewResourceName,
	buildPreviewResourceNames,
	cleanupPreviewResources,
	deletePreviewD1Database,
	deletePreviewKvNamespace,
	deletePreviewQueue,
	deletePreviewR2Bucket,
	deletePreviewWorkerScript,
	listPreviewWorkerNames,
	previewResourceNamePattern,
	removePreviewQueueConsumers,
	type PreviewResourceKind,
} from './preview-resources.ts'
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

function wranglerArgs(call: unknown) {
	const args = (call as [string, Array<string>])[1] ?? []
	return args
}

function wranglerArgList(call: unknown) {
	return wranglerArgs(call).join(' ')
}

function alreadyMissingWrangler(args: ReadonlyArray<string>) {
	const joined = args.join(' ')
	if (joined.includes('d1 list')) {
		return { status: 0, stdout: '[]\n', stderr: '' }
	}
	if (joined.includes('kv namespace list')) {
		return { status: 0, stdout: '[]\n', stderr: '' }
	}
	if (joined.startsWith('delete ') || joined.startsWith('r2 bucket delete ')) {
		return { status: 1, stdout: '', stderr: 'Worker not found\n' }
	}
	if (joined.includes('d1 delete') || joined.includes('kv namespace delete')) {
		return { status: 1, stdout: '', stderr: 'does not exist\n' }
	}
	return { status: 1, stdout: '', stderr: `unexpected wrangler: ${joined}` }
}

function emptyQueueListResponse() {
	return Response.json({
		success: true,
		result: [],
		result_info: { total_pages: 1 },
	})
}

function queueListResponse(name: string, queueId: string) {
	return Response.json({
		success: true,
		result: [{ queue_id: queueId, queue_name: name }],
		result_info: { total_pages: 1 },
	})
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

function installCleanupEnv() {
	vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account')
	vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token')
}

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

test('assertPreviewResourceName rejects every committed production and shared resource name', async () => {
	const committed = await readCommittedResourceNames()
	expect(committed.length).toBeGreaterThan(20)
	expect(committed).toContain('kody')
	expect(committed).toContain('kody-audit')
	expect(committed).toContain('kody-community-assets')
	expect(committed).toContain('kody-webhook-dispatch')
	expect(committed).toContain('kody-scheduled-dispatch')
	expect(committed).toContain('kody-preview-jobs')
	expect(
		namesAcceptedByGuard([...committed, ...derivedProductionNames]),
	).toEqual([])
	expect(() => assertPreviewResourceName('kody', 'worker')).toThrow(
		'Refusing to delete worker "kody": it does not match the preview resource naming scheme',
	)
	expect(() => assertPreviewResourceName('kody-preview-jobs', 'd1')).toThrow(
		'Refusing to delete d1 "kody-preview-jobs"',
	)
})

test('assertPreviewResourceName rejects names outside the kody-pr / kody-branch scheme', () => {
	expect(
		nonPreviewNames.filter((name) => previewResourceNamePattern.test(name)),
	).toEqual([])
	expect(namesAcceptedByGuard(nonPreviewNames)).toEqual([])
	expect(() => assertPreviewResourceName('kody-pr-preview', 'd1')).toThrow(
		'Refusing to delete d1 "kody-pr-preview"',
	)
})

test('assertPreviewResourceName accepts every derived preview name kind', () => {
	for (const workerName of acceptedWorkerNames) {
		const derived = buildPreviewResourceNames(workerName)
		const accepted: Array<[string, PreviewResourceKind]> = [
			[workerName, 'worker'],
			[`${workerName}-runtime`, 'worker'],
			[`${workerName}-platform`, 'worker'],
			[`${workerName}-jobs`, 'worker'],
			[`${workerName}-highlight`, 'worker'],
			[`${workerName}-mock-cloudflare`, 'worker'],
			[derived.d1DatabaseName, 'd1'],
			[derived.auditD1DatabaseName, 'd1'],
			[derived.oauthKvTitle, 'kv'],
			[derived.bundleArtifactsKvTitle, 'kv'],
			[derived.communityAssetsBucketName, 'r2'],
			[derived.emailBlobsBucketName, 'r2'],
			[derived.repoSessionBlobsBucketName, 'r2'],
			[derived.webhookDispatchQueueName, 'queue'],
			[derived.webhookDispatchDeadLetterQueueName, 'queue'],
		]
		expect(namesRejectedByGuard(accepted)).toEqual([])
	}
	expect(buildPreviewResourceNames('kody-pr-42')).toEqual({
		d1DatabaseName: 'kody-pr-42-db',
		auditD1DatabaseName: 'kody-pr-42-audit-db',
		oauthKvTitle: 'kody-pr-42-oauth-kv',
		bundleArtifactsKvTitle: 'kody-pr-42-bundle-artifacts-kv',
		communityAssetsBucketName: 'kody-pr-42-community-assets',
		emailBlobsBucketName: 'kody-pr-42-email-blobs',
		repoSessionBlobsBucketName: 'kody-pr-42-repo-session-blobs',
		webhookDispatchQueueName: 'kody-pr-42-webhook-dispatch',
		webhookDispatchDeadLetterQueueName: 'kody-pr-42-webhook-dispatch-dlq',
	})
	expect(listPreviewWorkerNames('kody-pr-42')).not.toContain(
		'kody-preview-jobs',
	)
})

test('assertPreviewResourceName accepts names truncated to the 63-character limit', () => {
	const workerName = `kody-branch-${'a1'.repeat(15)}-z`
	expect(workerName).toHaveLength(44)
	const derived = buildPreviewResourceNames(workerName)
	expect(derived.bundleArtifactsKvTitle.length).toBeLessThanOrEqual(63)
	expect(derived.bundleArtifactsKvTitle).not.toContain(workerName)
	expect(derived.bundleArtifactsKvTitle).toMatch(
		/^kody-branch-[a-z0-9]+-bundle-artifacts-kv$/,
	)
	expect(
		namesRejectedByGuard(
			Object.values(derived).map((name) => [name, 'kv'] as const),
		),
	).toEqual([])
})

test('cleanupPreviewResources refuses a production worker name before any wrangler or REST call', async () => {
	const fetchMock = vi.fn<typeof fetch>()
	vi.stubGlobal('fetch', fetchMock)
	installCleanupEnv()
	for (const workerName of ['kody', 'kody-platform', 'kody-runtime', '']) {
		await expect(
			cleanupPreviewResources({ workerName, dryRun: false }),
		).rejects.toThrow('does not match the preview resource naming scheme')
	}
	expect(spawnSync).not.toHaveBeenCalled()
	expect(fetchMock).not.toHaveBeenCalled()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('cleanupPreviewResources refuses a production worker name even in dry-run', async () => {
	await expect(
		cleanupPreviewResources({ workerName: 'kody', dryRun: true }),
	).rejects.toThrow('Refusing to delete worker "kody-runtime"')
	expect(consoleError).not.toHaveBeenCalled()
	expect(spawnSync).not.toHaveBeenCalled()
})

test('each guarded delete throws with the offending name and kind before reaching Cloudflare', async () => {
	const fetchMock = vi.fn<typeof fetch>()
	vi.stubGlobal('fetch', fetchMock)
	installCleanupEnv()
	const queueClient = {
		accountId: 'test-account',
		apiToken: 'test-token',
		dryRun: false,
	}
	await expect(
		deletePreviewWorkerScript({ name: 'kody-platform', dryRun: false }),
	).rejects.toThrow('Refusing to delete worker "kody-platform"')
	await expect(
		deletePreviewD1Database({ name: 'kody', dryRun: false }),
	).rejects.toThrow('Refusing to delete d1 "kody"')
	await expect(
		deletePreviewD1Database({ name: 'kody-audit', dryRun: false }),
	).rejects.toThrow('Refusing to delete d1 "kody-audit"')
	await expect(
		deletePreviewKvNamespace({ title: 'kody-oauth', dryRun: false }),
	).rejects.toThrow('Refusing to delete kv "kody-oauth"')
	await expect(
		deletePreviewR2Bucket({ name: 'kody-community-assets', dryRun: false }),
	).rejects.toThrow('Refusing to delete r2 "kody-community-assets"')
	await expect(
		deletePreviewQueue({ ...queueClient, name: 'kody-webhook-dispatch' }),
	).rejects.toThrow('Refusing to delete queue "kody-webhook-dispatch"')
	await expect(
		removePreviewQueueConsumers({
			...queueClient,
			name: 'kody-email-delivery',
		}),
	).rejects.toThrow('Refusing to delete queue "kody-email-delivery"')
	expect(spawnSync).not.toHaveBeenCalled()
	expect(fetchMock).not.toHaveBeenCalled()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('dry-run cleanup of a PR preview walks every resource without touching Cloudflare', async () => {
	consoleError.mockImplementation(() => {})
	const fetchMock = vi.fn<typeof fetch>()
	vi.stubGlobal('fetch', fetchMock)
	await cleanupPreviewResources({ workerName: 'kody-pr-42', dryRun: true })
	const logged = consoleError.mock.calls.map(([message]) => String(message))
	expect(logged).toEqual(
		expect.arrayContaining([
			'[dry-run] remove Queue consumers: kody-pr-42-webhook-dispatch',
			'[dry-run] remove Queue consumers: kody-pr-42-webhook-dispatch-dlq',
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
			'[dry-run] delete D1 database: kody-pr-42-audit-db',
			'[dry-run] delete D1 database: kody-pr-42-db',
		]),
	)
	expect(logged.some((line) => line.includes('kody-preview-jobs'))).toBe(false)
	expect(spawnSync).not.toHaveBeenCalled()
	expect(fetchMock).not.toHaveBeenCalled()
	vi.unstubAllGlobals()
})

test('cleanup retries a wrangler 504 then continues later independent resources', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => emptyQueueListResponse())
	vi.stubGlobal('fetch', fetchMock)
	let highlightAttempts = 0
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'delete' && argv[1] === 'kody-pr-2017-highlight') {
			highlightAttempts += 1
			if (highlightAttempts === 1) {
				return {
					status: 1,
					stdout: '',
					stderr: 'Gateway Timeout [code: 504]\n',
				}
			}
			return { status: 0, stdout: '', stderr: '' }
		}
		return alreadyMissingWrangler(argv)
	})

	await cleanupPreviewResources({
		workerName: 'kody-pr-2017',
		dryRun: false,
		sleep: async () => {},
	})

	expect(highlightAttempts).toBe(2)
	const wranglerCalls = spawnSync.mock.calls.map((call) =>
		wranglerArgList(call),
	)
	expect(wranglerCalls).toContain('delete kody-pr-2017-highlight --force')
	expect(wranglerCalls).toContain('delete kody-pr-2017-mock-cloudflare --force')
	expect(
		wranglerCalls.some((call) => call.startsWith('r2 bucket delete ')),
	).toBe(true)
	expect(wranglerCalls.some((call) => call.includes('d1 list'))).toBe(true)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('cleanup retries a wrangler 429 then succeeds', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => emptyQueueListResponse())
	vi.stubGlobal('fetch', fetchMock)
	let runtimeAttempts = 0
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'delete' && argv[1] === 'kody-pr-8-runtime') {
			runtimeAttempts += 1
			if (runtimeAttempts === 1) {
				return {
					status: 1,
					stdout: '',
					stderr: 'Cloudflare API request failed (429): Rate limited\n',
				}
			}
			return { status: 0, stdout: '', stderr: '' }
		}
		return alreadyMissingWrangler(argv)
	})

	await cleanupPreviewResources({
		workerName: 'kody-pr-8',
		dryRun: false,
		sleep: async () => {},
	})
	expect(runtimeAttempts).toBe(2)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('permanent queue auth failure still attempts later independent resources and aggregates leftovers', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
		const url = String(input)
		if (url.includes('/r2/buckets/')) {
			return emptyQueueListResponse()
		}
		return authForbiddenResponse()
	})
	vi.stubGlobal('fetch', fetchMock)
	const attemptedWorkers: Array<string> = []
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'delete') {
			attemptedWorkers.push(argv[1] ?? '')
			if (argv[1] === 'kody-pr-1999-highlight') {
				return {
					status: 1,
					stdout: '',
					stderr: 'Authentication error [code: 10000]\n',
				}
			}
		}
		return alreadyMissingWrangler(argv)
	})

	await expect(
		cleanupPreviewResources({
			workerName: 'kody-pr-1999',
			dryRun: false,
			sleep: async () => {},
		}),
	).rejects.toThrow(/Preview cleanup failed for 5 resource\(s\)/)
	expect(
		attemptedWorkers.filter((name) => name === 'kody-pr-1999-highlight'),
	).toEqual(['kody-pr-1999-highlight'])

	expect(attemptedWorkers).toEqual(
		expect.arrayContaining([
			'kody-pr-1999-runtime',
			'kody-pr-1999-platform',
			'kody-pr-1999',
			'kody-pr-1999-jobs',
			'kody-pr-1999-highlight',
			'kody-pr-1999-mock-cloudflare',
		]),
	)
	const wranglerCalls = spawnSync.mock.calls.map((call) =>
		wranglerArgList(call),
	)
	expect(
		wranglerCalls.some((call) => call.startsWith('r2 bucket delete ')),
	).toBe(true)
	expect(wranglerCalls).toContain('d1 list --json')
	expect(wranglerCalls).toContain('kv namespace list')
	expect(fetchMock).toHaveBeenCalled()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('already-missing preview resources are successful and idempotent', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => emptyQueueListResponse())
	vi.stubGlobal('fetch', fetchMock)
	spawnSync.mockImplementation((_command, args) =>
		alreadyMissingWrangler(args as Array<string>),
	)

	await cleanupPreviewResources({
		workerName: 'kody-pr-42',
		dryRun: false,
		sleep: async () => {},
	})
	const logged = consoleError.mock.calls.map(([message]) => String(message))
	expect(logged).toEqual(
		expect.arrayContaining([
			'Queue already deleted (no consumers to remove): kody-pr-42-webhook-dispatch',
			'Worker script already deleted: kody-pr-42',
			'Queue already deleted: kody-pr-42-webhook-dispatch',
			'R2 bucket already deleted: kody-pr-42-community-assets',
			'D1 database already deleted: kody-pr-42-db',
			'KV namespace already deleted: kody-pr-42-oauth-kv',
		]),
	)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('cleanup preserves queue-consumer then worker then queue order', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const events: Array<string> = []
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
		const url = String(input)
		if (url.includes('/queues?')) {
			events.push(`list-queues`)
			return emptyQueueListResponse()
		}
		return emptyQueueListResponse()
	})
	vi.stubGlobal('fetch', fetchMock)
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'delete') {
			events.push(`delete-worker ${argv[1]}`)
		}
		if (argv[0] === 'r2') {
			events.push(`delete-r2 ${argv[3]}`)
		}
		if (argv[0] === 'd1' && argv[1] === 'list') {
			events.push('list-d1')
		}
		return alreadyMissingWrangler(argv)
	})

	await cleanupPreviewResources({
		workerName: 'kody-pr-9',
		dryRun: false,
		sleep: async () => {},
	})

	const firstWorker = events.indexOf('delete-worker kody-pr-9-runtime')
	const firstQueueList = events.indexOf('list-queues')
	const firstR2 = events.findIndex((event) => event.startsWith('delete-r2 '))
	expect(firstQueueList).toBeGreaterThanOrEqual(0)
	expect(firstWorker).toBeGreaterThan(firstQueueList)
	expect(firstR2).toBeGreaterThan(firstWorker)
	expect(events.filter((event) => event === 'list-queues').length).toBe(4)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('non-empty preview R2 buckets are emptied then deleted', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const deletedObjectUrls: Array<string> = []
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockImplementation(async (input, init) => {
			const url = String(input)
			if (url.includes('/r2/buckets/') && url.includes('/objects')) {
				if ((init?.method ?? 'GET') === 'DELETE') {
					deletedObjectUrls.push(url)
					return Response.json({ success: true, result: null })
				}
				return Response.json({
					success: true,
					result: [{ key: 'seeded/blob.bin' }],
					result_info: { total_pages: 1 },
				})
			}
			if (url.includes('/queues')) {
				return emptyQueueListResponse()
			}
			return emptyQueueListResponse()
		})
	vi.stubGlobal('fetch', fetchMock)
	const bucketDeletes: Array<string> = []
	spawnSync.mockImplementation((_command, args) => {
		const argv = args as Array<string>
		if (argv[0] === 'r2' && argv[1] === 'bucket' && argv[2] === 'delete') {
			const bucket = argv[3] ?? ''
			bucketDeletes.push(bucket)
			if (
				bucket === 'kody-pr-42-email-blobs' &&
				bucketDeletes.filter((name) => name === bucket).length === 1
			) {
				return {
					status: 1,
					stdout: '',
					stderr: 'The bucket you tried to delete is not empty\n',
				}
			}
			return { status: 0, stdout: '', stderr: '' }
		}
		return alreadyMissingWrangler(argv)
	})

	await cleanupPreviewResources({
		workerName: 'kody-pr-42',
		dryRun: false,
		sleep: async () => {},
	})

	expect(
		bucketDeletes.filter((name) => name === 'kody-pr-42-email-blobs'),
	).toEqual(['kody-pr-42-email-blobs', 'kody-pr-42-email-blobs'])
	expect(
		deletedObjectUrls.some((url) => url.includes('seeded%2Fblob.bin')),
	).toBe(true)
	expect(
		consoleError.mock.calls.some(([message]) =>
			String(message).includes(
				'Deleted R2 object: kody-pr-42-email-blobs/seeded/blob.bin',
			),
		),
	).toBe(true)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

test('cleanup never targets kody-preview-jobs or production names', async () => {
	consoleError.mockImplementation(() => {})
	installCleanupEnv()
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => emptyQueueListResponse())
	vi.stubGlobal('fetch', fetchMock)
	spawnSync.mockImplementation((_command, args) =>
		alreadyMissingWrangler(args as Array<string>),
	)

	await cleanupPreviewResources({
		workerName: 'kody-pr-42',
		dryRun: false,
		sleep: async () => {},
	})
	const targeted = [
		...spawnSync.mock.calls.map((call) => wranglerArgList(call)),
		...fetchMock.mock.calls.map(([input]) => String(input)),
	].join('\n')
	expect(targeted).not.toContain('kody-preview-jobs')
	expect(targeted).not.toContain('kody-jobs')
	expect(targeted).not.toMatch(/(?<!kody-pr-42-)kody-production/)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})
