import { readFileSync } from 'node:fs'

import { expect, test, vi } from 'vitest'
import {
	assertAdhocBackupPolicyReadback,
	createCloudflareBackupApi,
	ensureBackupResources,
	generateBackupDesiredState,
	redactBackupOutput,
	renderBackupOutput,
	type BackupCloudflareApi,
	type BackupDesiredState,
	type R2Bucket,
	type R2LifecyclePolicy,
	type R2LockPolicy,
} from './backup-resources.ts'
import {
	parseBackupCliArgs,
	runBackupResourcesCli,
} from './backup-resources-cli.ts'
import { reconcileBackupResources } from './backup-resources-reconcile-cli.ts'

const sourceAccountId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const destinationAccountId = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const normalizedSourceAccountId = sourceAccountId.toLowerCase()
const normalizedDestinationAccountId = destinationAccountId.toLowerCase()
const apiToken = 'provisioner-secret-value'
const sourceD1Uuid = '9f1c2f54-13f0-4fd4-8cf4-89ec2f9df71a'
const adhocPolicyProof = {
	prefix: 'adhoc/',
	lockRuleId: 'adhoc-backups-immutable-35-days',
	lockMinimumAgeSeconds: 35 * 86_400,
	lifecycleRuleId: 'expire-adhoc-backups-after-35-days',
	lifecycleMinimumAgeSeconds: 35 * 86_400,
	readBackVerified: true,
} as const

test('DR deployment reconciles adhoc policy before Worker deploy when authorized', () => {
	const workflow = readFileSync(
		new URL('../../.github/workflows/deploy.yml', import.meta.url),
		'utf8',
	)
	const policyStep = workflow.indexOf(
		'name: 🔒 Reconcile DR backup retention policies when authorized',
	)
	const deployStep = workflow.indexOf(
		'name: ☁️ Deploy backup control plane to DR account',
	)
	expect(policyStep).toBeGreaterThan(0)
	expect(deployStep).toBeGreaterThan(policyStep)
	expect(workflow).toContain(
		'DR_BACKUP_ADMIN_TOKEN: ${{ secrets.DR_BACKUP_ADMIN_TOKEN }}',
	)
	expect(workflow).toContain(
		'run: node tools/ci/backup-resources-reconcile-cli.ts',
	)
})

test('optional deploy reconciliation skips without the admin secret and applies when authorized', async () => {
	const outputs: Array<string> = []
	const skippedApply = vi.fn()
	expect(
		await reconcileBackupResources({
			env: {},
			log: (output) => outputs.push(output),
			apply: skippedApply,
		}),
	).toEqual({ status: 'skipped', reason: 'dr-backup-admin-token-unavailable' })
	expect(skippedApply).not.toHaveBeenCalled()
	expect(outputs.join('\n')).toContain('reconciliation skipped')
	expect(outputs.join('\n')).toContain(
		'Existing bucket policies remain unchanged',
	)

	outputs.length = 0
	const apply = vi.fn(async () => ({
		status: 'applied' as const,
		adhocPolicyProof,
	}))
	expect(
		await reconcileBackupResources({
			env: {
				DR_BACKUP_ADMIN_TOKEN: apiToken,
				BACKUP_DESTINATION_ACCOUNT_ID: destinationAccountId,
			},
			log: (output) => outputs.push(output),
			apply,
		}),
	).toEqual({ status: 'reconciled', adhocPolicyProof })
	expect(apply).toHaveBeenCalledWith(
		expect.objectContaining({
			argv: ['apply'],
			env: expect.objectContaining({ CLOUDFLARE_API_TOKEN: apiToken }),
		}),
	)
	expect(outputs.join('\n')).toContain('reconciliation complete')
})

const sourceD1Databases = [
	{ uuid: sourceD1Uuid, name: 'kody-production-database' },
]
const destinationApi = `https://api.cloudflare.com/client/v4/accounts/${normalizedDestinationAccountId}/r2/buckets`

function createDesired(
	overrides: Partial<Parameters<typeof generateBackupDesiredState>[0]> = {},
): BackupDesiredState {
	return generateBackupDesiredState({
		sourceAccountId,
		destinationAccountId,
		bucketName: 'kody-d1-backup-archive',
		workerName: 'kody-d1-backup-writer',
		sourceD1Databases,
		productionResourceDenylist: ['kody-email-blobs', 'kody-community-assets'],
		...overrides,
	})
}

function createFakeApi(input?: {
	bucket?: R2Bucket
	lockPolicy?: R2LockPolicy
	lifecyclePolicy?: R2LifecyclePolicy
	discardPolicyWrites?: boolean
}) {
	let bucket: R2Bucket | undefined
	let lockPolicy: R2LockPolicy | undefined
	let lifecyclePolicy: R2LifecyclePolicy | undefined
	bucket = input?.bucket
	lockPolicy = structuredClone(input?.lockPolicy)
	lifecyclePolicy = structuredClone(input?.lifecyclePolicy)
	const writes: Array<string> = []
	const api: BackupCloudflareApi = {
		async getBucket(name) {
			return bucket?.name === name ? bucket : undefined
		},
		async createBucket(input) {
			writes.push('create-bucket')
			bucket = { name: input.name }
			return bucket
		},
		async getBucketLockPolicy() {
			return lockPolicy
		},
		async putBucketLockPolicy(_bucketName, policy) {
			writes.push('put-lock-policy')
			if (!input?.discardPolicyWrites) {
				lockPolicy = structuredClone(policy)
			}
		},
		async getBucketLifecyclePolicy() {
			return lifecyclePolicy
		},
		async putBucketLifecyclePolicy(_bucketName, policy) {
			writes.push('put-lifecycle-policy')
			if (!input?.discardPolicyWrites) {
				lifecyclePolicy = structuredClone(policy)
			}
		},
	}
	return { api, writes }
}

function jsonResponse(result: unknown, status = 200) {
	return new Response(JSON.stringify({ success: true, result }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

test('backup desired state keeps private prefixes, retention ages, and account isolation', () => {
	const desired = createDesired()

	expect(desired.bucket).toEqual({
		name: 'kody-d1-backup-archive',
		privacy: 'private-by-default',
	})
	expect(
		desired.lockPolicy.rules.map((rule) => ({
			prefix: rule.prefix,
			maxAgeSeconds:
				rule.condition.type === 'Age'
					? rule.condition.maxAgeSeconds
					: undefined,
			enabled: rule.enabled,
		})),
	).toEqual([
		{ prefix: 'daily/', maxAgeSeconds: 35 * 86_400, enabled: true },
		{ prefix: 'weekly/', maxAgeSeconds: 400 * 86_400, enabled: true },
		{ prefix: 'adhoc/', maxAgeSeconds: 35 * 86_400, enabled: true },
		{ prefix: 'blobs/', maxAgeSeconds: 400 * 86_400, enabled: true },
		{ prefix: 'escrow/', maxAgeSeconds: 400 * 86_400, enabled: true },
	])
	expect(
		desired.lifecyclePolicy.rules.map((rule) => ({
			prefix: rule.conditions.prefix,
			maxAge:
				rule.deleteObjectsTransition?.condition?.type === 'Age'
					? rule.deleteObjectsTransition.condition.maxAge
					: undefined,
			enabled: rule.enabled,
		})),
	).toEqual([
		{ prefix: 'daily/', maxAge: 35 * 86_400, enabled: true },
		{ prefix: 'weekly/', maxAge: 400 * 86_400, enabled: true },
		{ prefix: 'adhoc/', maxAge: 35 * 86_400, enabled: true },
	])
	expect(desired.retentionSemantics.bucketLockOverridesLifecycle).toBe(true)
	expect(desired.runtimeContract.accounts).toEqual({
		sourceAccountId: normalizedSourceAccountId,
		destinationAccountId: normalizedDestinationAccountId,
	})
	expect(desired.runtimeContract.sourceD1DatabaseAllowlist).toEqual(
		sourceD1Databases,
	)
	expect(desired.runtimeContract.r2Binding).toMatchObject({
		destinationAccountId: normalizedDestinationAccountId,
		bucketName: 'kody-d1-backup-archive',
		allowedPrefixes: [
			'daily/',
			'weekly/',
			'adhoc/',
			'staging/',
			'blobs/',
			'escrow/',
			'pre-restore/',
		],
	})
	expect(desired.readiness.bucketPrivateByDefault).toBe(true)
	expect(desired.tokenRequirements.provisioner).toMatchObject({
		destinationAccountId: normalizedDestinationAccountId,
		bucketName: 'kody-d1-backup-archive',
	})
})

test('generation and CLI reject non-dedicated resources and invalid D1 allowlists', () => {
	const invalidGeneration: Array<
		[Parameters<typeof createDesired>[0], string]
	> = [
		[
			{
				bucketName: 'kody-email-blobs',
				productionResourceDenylist: ['kody-email-blobs'],
			},
			'distinct from production resources',
		],
		[
			{ sourceD1Databases: [{ uuid: 'not-a-uuid', name: 'production-db' }] },
			'UUID and lower-kebab name pairs',
		],
		[
			{ sourceAccountId: destinationAccountId.toLowerCase() },
			'account IDs must be distinct',
		],
		[
			{ sourceAccountId: 'not-an-account-id' },
			'exactly 32 hexadecimal characters',
		],
		[
			{ destinationAccountId: 'g'.repeat(32) },
			'exactly 32 hexadecimal characters',
		],
	]
	for (const [overrides, error] of invalidGeneration) {
		expect(() => createDesired(overrides)).toThrow(error)
	}

	const cliEnv = {
		BACKUP_SOURCE_ACCOUNT_ID: sourceAccountId,
		CLOUDFLARE_ACCOUNT_ID: destinationAccountId,
		CLOUDFLARE_API_TOKEN: apiToken,
	}
	const options = parseBackupCliArgs(
		[
			'--source-d1',
			`${sourceD1Uuid}:kody-production-database`,
			'--deny-production-resource',
			'kody-email-blobs',
		],
		{ ...cliEnv, BACKUP_R2_BUCKET_NAME: 'kody-d1-backup-archive' },
	)
	expect(options).toMatchObject({
		mode: 'plan',
		sourceAccountId: normalizedSourceAccountId,
		destinationAccountId: normalizedDestinationAccountId,
		bucketName: 'kody-d1-backup-archive',
		sourceD1Databases,
		productionResourceDenylist: ['kody-email-blobs'],
	})
	expect(
		parseBackupCliArgs(
			[
				'apply',
				'--source-account-id',
				sourceAccountId,
				'--destination-account-id',
				destinationAccountId,
				'--source-d1',
				`${sourceD1Uuid}:kody-production-database`,
				'--provisioner-token-env',
				'BACKUP_PROVISIONER_TOKEN',
			],
			{ BACKUP_PROVISIONER_TOKEN: apiToken },
		).mode,
	).toBe('apply')
	const invalidCli: Array<[Array<string>, Record<string, string>, string]> = [
		[
			['--provisioner-token', apiToken],
			{ CLOUDFLARE_API_TOKEN: 'safe-environment-token' },
			'Unknown backup flag: --provisioner-token',
		],
		[
			['--api-base-url', 'https://example.test'],
			{},
			'Unknown backup flag: --api-base-url',
		],
		[
			[],
			{ BACKUP_SOURCE_ACCOUNT_ID: destinationAccountId.toLowerCase() },
			'account IDs must be distinct',
		],
		[
			[],
			{ BACKUP_SOURCE_ACCOUNT_ID: 'abc123' },
			'exactly 32 hexadecimal characters',
		],
	]
	for (const [argv, env, error] of invalidCli) {
		expect(() => parseBackupCliArgs(argv, { ...cliEnv, ...env })).toThrow(error)
	}
})

test('plan and apply converge idempotently without provisioning a Worker', async () => {
	const fake = createFakeApi()
	const desired = createDesired()
	const logs: Array<string> = []

	const planned = await ensureBackupResources({
		api: fake.api,
		desired,
		dryRun: true,
		log: (message) => logs.push(message),
	})
	expect(planned.plan.actions.map(({ type }) => type)).toEqual([
		'create-bucket',
		'put-lock-policy',
		'put-lifecycle-policy',
	])
	expect(fake.writes).toEqual([])
	expect(logs.join('\n')).not.toContain(apiToken)

	const applied = await ensureBackupResources({
		api: fake.api,
		desired,
		dryRun: false,
	})
	expect(applied.appliedActions).toBe(3)
	expect(applied.adhocPolicyProof).toEqual(adhocPolicyProof)
	expect(fake.writes).toEqual([
		'create-bucket',
		'put-lock-policy',
		'put-lifecycle-policy',
	])

	fake.writes.length = 0
	const repeated = await ensureBackupResources({
		api: fake.api,
		desired,
		dryRun: false,
	})
	expect(repeated.appliedActions).toBe(0)
	expect(repeated.plan.actions).toEqual([])
	expect(fake.writes).toEqual([])
})

test('apply preserves unknown legal holds and stronger managed retention', async () => {
	const desired = createDesired()
	const unknownLockRule: R2LockPolicy['rules'][number] = {
		id: 'legal-hold',
		enabled: true,
		prefix: 'investigation/',
		condition: { type: 'Indefinite' },
	}
	const unknownLifecycleRule: R2LifecyclePolicy['rules'][number] = {
		id: 'abort-stale-multipart-uploads',
		enabled: true,
		conditions: { prefix: '' },
		abortMultipartUploadsTransition: {
			condition: { type: 'Age', maxAge: 7 * 86_400 },
		},
	}
	const [dailyLock] = desired.lockPolicy.rules
	const [dailyLifecycle] = desired.lifecyclePolicy.rules
	if (!dailyLock || !dailyLifecycle) {
		throw new Error('expected daily lock and lifecycle rules')
	}
	const strongerDailyLock = {
		...dailyLock,
		condition: { type: 'Age' as const, maxAgeSeconds: 90 * 86_400 },
	}
	const strongerDailyLifecycle = {
		...dailyLifecycle,
		deleteObjectsTransition: {
			condition: { type: 'Age' as const, maxAge: 90 * 86_400 },
		},
	}
	const fake = createFakeApi({
		bucket: { name: desired.bucket.name },
		lockPolicy: { rules: [unknownLockRule, strongerDailyLock] },
		lifecyclePolicy: {
			rules: [unknownLifecycleRule, strongerDailyLifecycle],
		},
	})

	const applied = await ensureBackupResources({
		api: fake.api,
		desired,
		dryRun: false,
	})
	const lockRequest = applied.plan.actions.find(
		(action) => action.type === 'put-lock-policy',
	)
	const lifecycleRequest = applied.plan.actions.find(
		(action) => action.type === 'put-lifecycle-policy',
	)
	expect(lockRequest?.request.rules).toEqual(
		expect.arrayContaining([unknownLockRule, strongerDailyLock]),
	)
	expect(lifecycleRequest?.request.rules).toEqual(
		expect.arrayContaining([unknownLifecycleRule, strongerDailyLifecycle]),
	)

	fake.writes.length = 0
	const repeated = await ensureBackupResources({
		api: fake.api,
		desired,
		dryRun: false,
	})
	expect(repeated.plan.actions).toEqual([])
	expect(fake.writes).toEqual([])
})

test('apply fails when Cloudflare read-back does not contain written policies', async () => {
	const desired = createDesired()
	const fake = createFakeApi({ discardPolicyWrites: true })

	await expect(
		ensureBackupResources({
			api: fake.api,
			desired,
			dryRun: false,
		}),
	).rejects.toThrow('did not converge after apply')
})

test('adhoc policy proof fails closed on missing, disabled, or weak read-back', () => {
	const desired = createDesired()
	expect(
		assertAdhocBackupPolicyReadback({
			lockPolicy: desired.lockPolicy,
			lifecyclePolicy: desired.lifecyclePolicy,
		}),
	).toMatchObject({ prefix: 'adhoc/', readBackVerified: true })
	const { lockPolicy, lifecyclePolicy } = desired
	const lockAdhoc = (patch: Partial<R2LockPolicy['rules'][number]>) => ({
		rules: lockPolicy.rules.map((rule) =>
			rule.prefix === 'adhoc/' ? { ...rule, ...patch } : rule,
		),
	})
	const lifecycleAdhoc = (
		patch: Partial<R2LifecyclePolicy['rules'][number]>,
	) => ({
		rules: lifecyclePolicy.rules.map((rule) =>
			rule.conditions.prefix === 'adhoc/' ? { ...rule, ...patch } : rule,
		),
	})
	for (const input of [
		{
			lockPolicy: {
				rules: lockPolicy.rules.filter((rule) => rule.prefix !== 'adhoc/'),
			},
			lifecyclePolicy,
		},
		{ lockPolicy, lifecyclePolicy: lifecycleAdhoc({ enabled: false }) },
		{
			lockPolicy: lockAdhoc({
				condition: { type: 'Age', maxAgeSeconds: 34 * 86_400 },
			}),
			lifecyclePolicy,
		},
		{
			lockPolicy,
			lifecyclePolicy: lifecycleAdhoc({
				deleteObjectsTransition: {
					condition: { type: 'Age', maxAge: 34 * 86_400 },
				},
			}),
		},
	]) {
		expect(() => assertAdhocBackupPolicyReadback(input)).toThrow(
			'node tools/ci/backup-resources-cli.ts apply',
		)
	}
})

test('REST adapter uses documented bucket, lock, and lifecycle contracts', async () => {
	const desired = createDesired()
	const requests: Array<{ url: string; init: RequestInit }> = []
	const responses = [
		new Response(null, { status: 404 }),
		jsonResponse({ name: desired.bucket.name }),
		jsonResponse(desired.lockPolicy),
		jsonResponse(desired.lifecyclePolicy),
		jsonResponse({ name: desired.bucket.name }),
		jsonResponse(desired.lockPolicy),
		jsonResponse(desired.lifecyclePolicy),
	]
	const fetcher = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), init: init ?? {} })
			const response = responses.shift()
			if (!response) throw new Error('Unexpected request')
			return response
		},
	) as typeof fetch
	const api = createCloudflareBackupApi({
		destinationAccountId,
		apiToken,
		apiBaseUrl: 'https://api.example.test/client/v4/',
		fetcher,
	})

	const result = await ensureBackupResources({
		api,
		desired,
		dryRun: false,
	})
	expect(result.appliedActions).toBe(3)
	const testBucket = `https://api.example.test/client/v4/accounts/${normalizedDestinationAccountId}/r2/buckets`
	expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
		['GET', `${testBucket}/kody-d1-backup-archive`],
		['POST', testBucket],
		['PUT', `${testBucket}/kody-d1-backup-archive/lock`],
		['PUT', `${testBucket}/kody-d1-backup-archive/lifecycle`],
		['GET', `${testBucket}/kody-d1-backup-archive`],
		['GET', `${testBucket}/kody-d1-backup-archive/lock`],
		['GET', `${testBucket}/kody-d1-backup-archive/lifecycle`],
	])
	expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
		name: 'kody-d1-backup-archive',
	})
	expect(JSON.parse(String(requests[2]?.init.body))).toEqual(desired.lockPolicy)
	expect(JSON.parse(String(requests[3]?.init.body))).toEqual(
		desired.lifecyclePolicy,
	)
	for (const request of requests) {
		expect(request.init.headers).toMatchObject({
			Authorization: `Bearer ${apiToken}`,
		})
	}
	expect(renderBackupOutput(result)).not.toContain(apiToken)

	const readRequests: Array<string> = []
	const readResponses = [
		jsonResponse({ name: desired.bucket.name }),
		jsonResponse(desired.lockPolicy),
		jsonResponse(desired.lifecyclePolicy),
	]
	const readApi = createCloudflareBackupApi({
		destinationAccountId,
		apiToken,
		fetcher: vi.fn(async (url: string | URL | Request) => {
			readRequests.push(String(url))
			const response = readResponses.shift()
			if (!response) throw new Error('Unexpected request')
			return response
		}) as typeof fetch,
	})
	const converged = await ensureBackupResources({
		api: readApi,
		desired,
		dryRun: true,
	})
	expect(converged.plan.actions).toEqual([])
	expect(readRequests).toEqual([
		`${destinationApi}/kody-d1-backup-archive`,
		`${destinationApi}/kody-d1-backup-archive/lock`,
		`${destinationApi}/kody-d1-backup-archive/lifecycle`,
	])
})

test('REST adapter reports authentication, authorization, rate, server, and malformed failures safely', async () => {
	expect(() =>
		createCloudflareBackupApi({
			destinationAccountId: 'invalid-account',
			apiToken,
		}),
	).toThrow('exactly 32 hexadecimal characters')

	for (const status of [401, 403, 429, 500, 503]) {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ secret: apiToken }), {
					status,
					statusText: 'upstream failure',
				}),
		) as typeof fetch
		const api = createCloudflareBackupApi({
			destinationAccountId,
			apiToken,
			fetcher,
		})
		const thrown = await api.getBucket('kody-d1-backup-archive').then(
			() => null,
			(error: unknown) => error,
		)
		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toContain(String(status))
		expect((thrown as Error).message).not.toContain(apiToken)
	}

	for (const response of [
		new Response('not-json', { status: 200 }),
		jsonResponse(undefined),
		jsonResponse({ wrong: 'shape' }),
	]) {
		const api = createCloudflareBackupApi({
			destinationAccountId,
			apiToken,
			fetcher: vi.fn(async () => response.clone()) as typeof fetch,
		})
		await expect(api.getBucket('kody-d1-backup-archive')).rejects.toThrow(
			'Malformed Cloudflare response',
		)
	}

	const malformedLockApi = createCloudflareBackupApi({
		destinationAccountId,
		apiToken,
		fetcher: vi.fn(async () =>
			jsonResponse({ rules: [{ condition: { type: 'Forever' } }] }),
		) as typeof fetch,
	})
	await expect(
		malformedLockApi.getBucketLockPolicy('kody-d1-backup-archive'),
	).rejects.toThrow('Malformed Cloudflare response')
})

test('CLI defaults to plan and never renders its provisioner token', async () => {
	const outputs: Array<string> = []
	const requestUrls: Array<string> = []
	const fetcher = vi.fn(async (url: string | URL | Request) => {
		requestUrls.push(String(url))
		return new Response(null, { status: 404 })
	}) as typeof fetch
	const result = await runBackupResourcesCli({
		argv: [
			'--source-d1',
			`${sourceD1Uuid}:kody-production-database`,
			'--deny-production-resource',
			'kody-email-blobs',
		],
		env: {
			BACKUP_SOURCE_ACCOUNT_ID: sourceAccountId,
			CLOUDFLARE_ACCOUNT_ID: destinationAccountId,
			CLOUDFLARE_API_TOKEN: apiToken,
			CLOUDFLARE_API_BASE_URL: 'https://attacker.example.test',
			BACKUP_R2_BUCKET_NAME: 'kody-d1-backup-archive',
		},
		fetcher,
		log: (output) => outputs.push(output),
	})
	expect(result.status).toBe('planned')
	expect(result.appliedActions).toBe(0)
	expect(requestUrls).toEqual([`${destinationApi}/kody-d1-backup-archive`])
	expect(outputs.join('\n')).not.toContain(apiToken)
	expect(JSON.parse(outputs[0] ?? '')).toMatchObject({
		plan: {
			desired: {
				runtimeContract: {
					accounts: {
						sourceAccountId: normalizedSourceAccountId,
						destinationAccountId: normalizedDestinationAccountId,
					},
					sourceD1DatabaseAllowlist: sourceD1Databases,
				},
			},
		},
	})

	const redacted = redactBackupOutput({
		provisionerToken: apiToken,
		authorization: `Bearer ${apiToken}`,
		tokenRequirements: { runtime: 'contract' },
		d1ExportTokenRequirements: { permission: 'D1 Edit' },
	})
	expect(JSON.stringify(redacted)).not.toContain(apiToken)
	expect(redacted).toHaveProperty('tokenRequirements.runtime', 'contract')
})
