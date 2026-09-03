import * as childProcess from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	assertPreviewResourceName,
	buildPreviewResourceNames,
	cleanupPreviewResources,
	deletePreviewD1Database,
	deletePreviewKvNamespace,
	deletePreviewQueue,
	deletePreviewR2Bucket,
	deletePreviewWorkerScript,
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
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
	vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account')
	vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token')
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
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

// Names production-resources.ts and the deploy workflow derive at deploy time
// rather than committing to a wrangler config.
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

/** Names the guard lets through; every entry is a guard bug. */
function namesAcceptedByGuard(names: ReadonlyArray<string>) {
	return names.filter((name) => guardAccepts(name, 'worker'))
}

/** Preview names the guard refuses; every entry would break cleanup. */
function namesRejectedByGuard(
	entries: ReadonlyArray<readonly [string, PreviewResourceKind]>,
) {
	return entries
		.filter(([name, kind]) => !guardAccepts(name, kind))
		.map(([name]) => name)
}

describe('assertPreviewResourceName', () => {
	test('rejects every committed production and shared resource name', async () => {
		const committed = await readCommittedResourceNames()
		expect(committed.length).toBeGreaterThan(20)
		expect(committed).toContain('kody')
		expect(committed).toContain('kody-audit')
		expect(committed).toContain('kody-community-assets')
		expect(committed).toContain('kody-webhook-dispatch')
		expect(committed).toContain('kody-scheduled-dispatch')
		expect(
			namesAcceptedByGuard([...committed, ...derivedProductionNames]),
		).toEqual([])
		expect(() => assertPreviewResourceName('kody', 'worker')).toThrow(
			'Refusing to delete worker "kody": it does not match the preview resource naming scheme',
		)
	})

	test('rejects names outside the kody-pr-<number> / kody-branch-<slug> scheme', () => {
		expect(
			nonPreviewNames.filter((name) => previewResourceNamePattern.test(name)),
		).toEqual([])
		expect(namesAcceptedByGuard(nonPreviewNames)).toEqual([])
		expect(() => assertPreviewResourceName('kody-pr-preview', 'd1')).toThrow(
			'Refusing to delete d1 "kody-pr-preview"',
		)
	})

	test('accepts every derived preview name kind for PR and branch previews', () => {
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
	})

	test('accepts names truncated to the 63-character Cloudflare limit', () => {
		// The workflow caps the slug at 32 characters; the longest suffix
		// (-bundle-artifacts-kv) pushes a max-length branch name past 63.
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
})

describe('preview cleanup delete path', () => {
	const queueClient = {
		accountId: 'test-account',
		apiToken: 'test-token',
		dryRun: false,
	}

	test('cleanupPreviewResources refuses a production worker name before any wrangler or REST call', async () => {
		for (const workerName of ['kody', 'kody-platform', 'kody-runtime', '']) {
			await expect(
				cleanupPreviewResources({ workerName, dryRun: false }),
			).rejects.toThrow('does not match the preview resource naming scheme')
		}
		expect(spawnSync).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('cleanupPreviewResources refuses a production worker name even in dry-run', async () => {
		await expect(
			cleanupPreviewResources({ workerName: 'kody', dryRun: true }),
		).rejects.toThrow('Refusing to delete queue "kody-webhook-dispatch"')
		expect(consoleError).not.toHaveBeenCalled()
	})

	test('each guarded delete throws with the offending name and kind before reaching Cloudflare', async () => {
		expect(() =>
			deletePreviewWorkerScript({ name: 'kody-platform', dryRun: false }),
		).toThrow('Refusing to delete worker "kody-platform"')
		expect(() =>
			deletePreviewD1Database({ name: 'kody', dryRun: false }),
		).toThrow('Refusing to delete d1 "kody"')
		expect(() =>
			deletePreviewD1Database({ name: 'kody-audit', dryRun: false }),
		).toThrow('Refusing to delete d1 "kody-audit"')
		expect(() =>
			deletePreviewKvNamespace({ title: 'kody-oauth', dryRun: false }),
		).toThrow('Refusing to delete kv "kody-oauth"')
		expect(() =>
			deletePreviewR2Bucket({ name: 'kody-community-assets', dryRun: false }),
		).toThrow('Refusing to delete r2 "kody-community-assets"')
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
	})

	test('dry-run cleanup of a PR preview walks every resource without touching Cloudflare', async () => {
		consoleError.mockImplementation(() => {})
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
		expect(spawnSync).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
