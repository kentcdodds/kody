const secondsPerDay = 86_400
const adhocRetentionSeconds = 35 * secondsPerDay
const sourceD1UuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const cloudflareAccountIdPattern = /^[0-9a-f]{32}$/i
const resourceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const sensitiveKeyPattern =
	/(?:authorization|credential|password|private.?key|secret|token)/i
const nonSecretContractKeys = new Set([
	'tokenRequirements',
	'd1ExportTokenRequirements',
])

type JsonRecord = Record<string, unknown>

export type SourceD1Database = {
	uuid: string
	name: string
}

export type R2Bucket = {
	name: string
	creation_date?: string
	jurisdiction?: 'default' | 'eu' | 'fedramp'
	location?: 'apac' | 'eeur' | 'enam' | 'weur' | 'wnam' | 'oc'
	storage_class?: 'Standard' | 'InfrequentAccess'
}

export type R2LockPolicy = {
	rules: Array<{
		id: string
		enabled: boolean
		prefix?: string
		condition:
			| { type: 'Age'; maxAgeSeconds: number }
			| { type: 'Date'; date: string }
			| { type: 'Indefinite' }
	}>
}

export type R2LifecyclePolicy = {
	rules: Array<{
		id: string
		enabled: boolean
		conditions: {
			prefix: string
		}
		deleteObjectsTransition?: {
			condition?:
				| { type: 'Age'; maxAge: number }
				| { type: 'Date'; date: string }
		}
		abortMultipartUploadsTransition?: {
			condition?: { type: 'Age'; maxAge: number }
		}
		storageClassTransitions?: Array<{
			condition:
				| { type: 'Age'; maxAge: number }
				| { type: 'Date'; date: string }
			storageClass: 'InfrequentAccess'
		}>
	}>
}

type R2LockRule = R2LockPolicy['rules'][number]
type R2LifecycleRule = R2LifecyclePolicy['rules'][number]

export type BackupRuntimeContract = {
	kind: 'dedicated-worker-runtime-contract'
	enforcement: 'deployment-configuration-not-cloudflare-identity-api'
	deployment: 'out-of-scope'
	identity: {
		workerName: string
		environment: 'production'
		dedicated: true
	}
	accounts: {
		sourceAccountId: string
		destinationAccountId: string
	}
	sourceD1DatabaseAllowlist: Array<SourceD1Database>
	d1ExportTokenRequirements: {
		cloudflarePermission: 'D1 Edit'
		cloudflareScope: 'source-account-wide'
		canMutateD1: true
		sourceAccountId: string
		allowedDatabaseUuids: Array<string>
		applicationMustEnforceAllowlist: true
		applicationAllowlistDoesNotScopeToken: true
		applicationAllowlistDoesNotMakeTokenReadOnly: true
	}
	r2Binding: {
		binding: 'BACKUP_BUCKET'
		destinationAccountId: string
		bucketName: string
		access: 'object-read-write'
		allowedPrefixes: [
			'daily/',
			'weekly/',
			'adhoc/',
			'staging/',
			'blobs/',
			'escrow/',
			'pre-restore/',
		]
	}
	explicitRuntimeProhibitions: [
		'r2.bucket.admin',
		'r2.bucket.public-access.admin',
		'r2.lifecycle.admin',
		'r2.lock.admin',
	]
}

export type BackupDesiredState = {
	bucket: {
		name: string
		privacy: 'private-by-default'
	}
	lockPolicy: R2LockPolicy
	lifecyclePolicy: R2LifecyclePolicy
	retentionSemantics: {
		bucketLockOverridesLifecycle: true
	}
	runtimeContract: BackupRuntimeContract
	tokenRequirements: {
		provisioner: {
			authentication: 'bearer-api-token-injected-not-rendered'
			cloudflarePermission: 'Workers R2 Storage Write'
			destinationAccountId: string
			bucketName: string
			operations: [
				'bucket.create',
				'bucket.read',
				'lock.read-write',
				'lifecycle.read-write',
			]
		}
		runtime: {
			d1: BackupRuntimeContract['d1ExportTokenRequirements']
			r2: BackupRuntimeContract['r2Binding']
			prohibitedPermissions: BackupRuntimeContract['explicitRuntimeProhibitions']
		}
	}
	readiness: {
		bucketPrivateByDefault: true
		publicExposureApiManagedHere: false
		requiresSeparateVerificationDisabled: ['r2.dev', 'custom-domain']
	}
}

export type BackupCloudflareApi = {
	getBucket(name: string): Promise<R2Bucket | undefined>
	createBucket(input: { name: string }): Promise<R2Bucket>
	getBucketLockPolicy(bucketName: string): Promise<R2LockPolicy | undefined>
	putBucketLockPolicy(bucketName: string, policy: R2LockPolicy): Promise<void>
	getBucketLifecyclePolicy(
		bucketName: string,
	): Promise<R2LifecyclePolicy | undefined>
	putBucketLifecyclePolicy(
		bucketName: string,
		policy: R2LifecyclePolicy,
	): Promise<void>
}

export type BackupPlanAction =
	| {
			type: 'create-bucket'
			request: { name: string }
	  }
	| {
			type: 'put-lock-policy'
			bucketName: string
			request: R2LockPolicy
	  }
	| {
			type: 'put-lifecycle-policy'
			bucketName: string
			request: R2LifecyclePolicy
	  }

export type BackupResourcePlan = {
	mode: 'plan'
	environment: 'production'
	desired: BackupDesiredState
	actions: Array<BackupPlanAction>
}

export type AdhocBackupPolicyProof = {
	prefix: 'adhoc/'
	lockRuleId: 'adhoc-backups-immutable-35-days'
	lockMinimumAgeSeconds: number
	lifecycleRuleId: 'expire-adhoc-backups-after-35-days'
	lifecycleMinimumAgeSeconds: number
	readBackVerified: true
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCloudflareAccountId(value: string, label: string) {
	const normalized = value.trim().toLowerCase()
	if (!cloudflareAccountIdPattern.test(normalized)) {
		throw new Error(`${label} must be exactly 32 hexadecimal characters.`)
	}
	return normalized
}

function assertBackupInput(input: {
	sourceAccountId: string
	destinationAccountId: string
	bucketName: string
	workerName: string
	sourceD1Databases: ReadonlyArray<SourceD1Database>
	productionResourceDenylist: ReadonlyArray<string>
}) {
	if (!input.sourceAccountId.trim()) {
		throw new Error('Source Cloudflare account ID is required.')
	}
	if (!input.destinationAccountId.trim()) {
		throw new Error('Destination Cloudflare account ID is required.')
	}
	if (input.sourceAccountId.trim() === input.destinationAccountId.trim()) {
		throw new Error(
			'Source and destination Cloudflare account IDs must be distinct.',
		)
	}
	if (
		!resourceNamePattern.test(input.bucketName) ||
		input.bucketName.length < 3 ||
		input.bucketName.length > 63
	) {
		throw new Error('Backup bucket name must be 3-63 lower-kebab characters.')
	}
	if (!resourceNamePattern.test(input.workerName)) {
		throw new Error('Backup Worker name must be lower-kebab-case.')
	}
	if (
		input.bucketName === input.workerName ||
		input.productionResourceDenylist.includes(input.bucketName)
	) {
		throw new Error(
			'Backup bucket must have a dedicated name distinct from production resources.',
		)
	}
	if (input.sourceD1Databases.length === 0) {
		throw new Error('At least one source production D1 database is required.')
	}
	const uuids = input.sourceD1Databases.map(({ uuid }) => uuid.toLowerCase())
	const names = input.sourceD1Databases.map(({ name }) => name)
	if (
		new Set(uuids).size !== uuids.length ||
		new Set(names).size !== names.length ||
		uuids.some((uuid) => !sourceD1UuidPattern.test(uuid)) ||
		names.some((name) => !resourceNamePattern.test(name))
	) {
		throw new Error(
			'Source D1 allowlist requires unique UUID and lower-kebab name pairs.',
		)
	}
}

export function generateBackupDesiredState(input: {
	sourceAccountId: string
	destinationAccountId: string
	bucketName: string
	workerName: string
	sourceD1Databases: ReadonlyArray<SourceD1Database>
	productionResourceDenylist?: ReadonlyArray<string>
}): BackupDesiredState {
	const sourceAccountId = normalizeCloudflareAccountId(
		input.sourceAccountId,
		'Source Cloudflare account ID',
	)
	const destinationAccountId = normalizeCloudflareAccountId(
		input.destinationAccountId,
		'Destination Cloudflare account ID',
	)
	const productionResourceDenylist = input.productionResourceDenylist ?? []
	assertBackupInput({
		...input,
		sourceAccountId,
		destinationAccountId,
		productionResourceDenylist,
	})
	const sourceD1DatabaseAllowlist = input.sourceD1Databases.map((database) => ({
		uuid: database.uuid.toLowerCase(),
		name: database.name,
	}))
	const lockPolicy: R2LockPolicy = {
		rules: [
			{
				id: 'daily-backups-immutable-35-days',
				enabled: true,
				prefix: 'daily/',
				condition: {
					type: 'Age',
					maxAgeSeconds: 35 * secondsPerDay,
				},
			},
			{
				id: 'weekly-backups-immutable-400-days',
				enabled: true,
				prefix: 'weekly/',
				condition: {
					type: 'Age',
					maxAgeSeconds: 400 * secondsPerDay,
				},
			},
			{
				id: 'adhoc-backups-immutable-35-days',
				enabled: true,
				prefix: 'adhoc/',
				condition: {
					type: 'Age',
					maxAgeSeconds: adhocRetentionSeconds,
				},
			},
			{
				id: 'blob-store-immutable-400-days',
				enabled: true,
				prefix: 'blobs/',
				condition: {
					type: 'Age',
					maxAgeSeconds: 400 * secondsPerDay,
				},
			},
			{
				id: 'escrow-immutable-400-days',
				enabled: true,
				prefix: 'escrow/',
				condition: {
					type: 'Age',
					maxAgeSeconds: 400 * secondsPerDay,
				},
			},
		],
	}
	const lifecyclePolicy: R2LifecyclePolicy = {
		rules: [
			{
				id: 'expire-daily-backups-after-35-days',
				enabled: true,
				conditions: { prefix: 'daily/' },
				deleteObjectsTransition: {
					condition: { type: 'Age', maxAge: 35 * secondsPerDay },
				},
			},
			{
				id: 'expire-weekly-backups-after-400-days',
				enabled: true,
				conditions: { prefix: 'weekly/' },
				deleteObjectsTransition: {
					condition: { type: 'Age', maxAge: 400 * secondsPerDay },
				},
			},
			{
				id: 'expire-adhoc-backups-after-35-days',
				enabled: true,
				conditions: { prefix: 'adhoc/' },
				deleteObjectsTransition: {
					condition: { type: 'Age', maxAge: adhocRetentionSeconds },
				},
			},
		],
	}
	const runtimeContract: BackupRuntimeContract = {
		kind: 'dedicated-worker-runtime-contract',
		enforcement: 'deployment-configuration-not-cloudflare-identity-api',
		deployment: 'out-of-scope',
		identity: {
			workerName: input.workerName,
			environment: 'production',
			dedicated: true,
		},
		accounts: {
			sourceAccountId,
			destinationAccountId,
		},
		sourceD1DatabaseAllowlist,
		d1ExportTokenRequirements: {
			cloudflarePermission: 'D1 Edit',
			cloudflareScope: 'source-account-wide',
			canMutateD1: true,
			sourceAccountId,
			allowedDatabaseUuids: sourceD1DatabaseAllowlist.map(({ uuid }) => uuid),
			applicationMustEnforceAllowlist: true,
			applicationAllowlistDoesNotScopeToken: true,
			applicationAllowlistDoesNotMakeTokenReadOnly: true,
		},
		r2Binding: {
			binding: 'BACKUP_BUCKET',
			destinationAccountId,
			bucketName: input.bucketName,
			access: 'object-read-write',
			allowedPrefixes: [
				'daily/',
				'weekly/',
				'adhoc/',
				'staging/',
				'blobs/',
				'escrow/',
				'pre-restore/',
			],
		},
		explicitRuntimeProhibitions: [
			'r2.bucket.admin',
			'r2.bucket.public-access.admin',
			'r2.lifecycle.admin',
			'r2.lock.admin',
		],
	}

	return {
		bucket: {
			name: input.bucketName,
			privacy: 'private-by-default',
		},
		lockPolicy,
		lifecyclePolicy,
		retentionSemantics: {
			bucketLockOverridesLifecycle: true,
		},
		runtimeContract,
		tokenRequirements: {
			provisioner: {
				authentication: 'bearer-api-token-injected-not-rendered',
				cloudflarePermission: 'Workers R2 Storage Write',
				destinationAccountId,
				bucketName: input.bucketName,
				operations: [
					'bucket.create',
					'bucket.read',
					'lock.read-write',
					'lifecycle.read-write',
				],
			},
			runtime: {
				d1: runtimeContract.d1ExportTokenRequirements,
				r2: runtimeContract.r2Binding,
				prohibitedPermissions: runtimeContract.explicitRuntimeProhibitions,
			},
		},
		readiness: {
			bucketPrivateByDefault: true,
			publicExposureApiManagedHere: false,
			requiresSeparateVerificationDisabled: ['r2.dev', 'custom-domain'],
		},
	}
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.map((entry) => canonicalize(entry))
			.sort((left, right) =>
				JSON.stringify(left).localeCompare(JSON.stringify(right)),
			)
	}
	if (!isRecord(value)) return value
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalize(entry)]),
	)
}

function samePolicy(left: unknown, right: unknown) {
	return (
		JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
	)
}

function mergeLockPolicy(
	existing: R2LockPolicy | undefined,
	desired: R2LockPolicy,
): R2LockPolicy {
	const rules = structuredClone(existing?.rules ?? [])
	for (const desiredRule of desired.rules) {
		const existingIndex = rules.findIndex(({ id }) => id === desiredRule.id)
		if (existingIndex === -1) {
			rules.push(structuredClone(desiredRule))
			continue
		}
		const existingRule = rules[existingIndex] as R2LockRule
		if (existingRule.prefix !== desiredRule.prefix) {
			throw new Error(
				`R2 lock rule ${desiredRule.id} conflicts with managed prefix ${desiredRule.prefix ?? ''}.`,
			)
		}
		if (existingRule.condition.type === 'Date') {
			throw new Error(
				`R2 lock rule ${desiredRule.id} uses a date condition whose retention strength cannot be safely compared.`,
			)
		}
		const existingIsAtLeastDesired =
			existingRule.condition.type === 'Indefinite' ||
			(existingRule.condition.type === 'Age' &&
				desiredRule.condition.type === 'Age' &&
				existingRule.condition.maxAgeSeconds >=
					desiredRule.condition.maxAgeSeconds)
		if (existingIsAtLeastDesired) {
			rules[existingIndex] = { ...existingRule, enabled: true }
			continue
		}
		rules[existingIndex] = { ...existingRule, ...structuredClone(desiredRule) }
	}
	return { rules }
}

function mergeLifecyclePolicy(
	existing: R2LifecyclePolicy | undefined,
	desired: R2LifecyclePolicy,
): R2LifecyclePolicy {
	const rules = structuredClone(existing?.rules ?? [])
	for (const desiredRule of desired.rules) {
		const existingIndex = rules.findIndex(({ id }) => id === desiredRule.id)
		if (existingIndex === -1) {
			rules.push(structuredClone(desiredRule))
			continue
		}
		const existingRule = rules[existingIndex] as R2LifecycleRule
		if (existingRule.conditions.prefix !== desiredRule.conditions.prefix) {
			throw new Error(
				`R2 lifecycle rule ${desiredRule.id} conflicts with managed prefix ${desiredRule.conditions.prefix}.`,
			)
		}
		const existingCondition = existingRule.deleteObjectsTransition?.condition
		const desiredCondition = desiredRule.deleteObjectsTransition?.condition
		if (existingCondition?.type === 'Date') {
			throw new Error(
				`R2 lifecycle rule ${desiredRule.id} uses a date condition whose retention strength cannot be safely compared.`,
			)
		}
		const existingIsAtLeastDesired =
			existingCondition?.type === 'Age' &&
			desiredCondition?.type === 'Age' &&
			existingCondition.maxAge >= desiredCondition.maxAge
		if (existingIsAtLeastDesired) {
			rules[existingIndex] = { ...existingRule, enabled: true }
			continue
		}
		rules[existingIndex] = {
			...existingRule,
			...structuredClone(desiredRule),
		}
	}
	return { rules }
}

export async function planBackupResources(input: {
	api: BackupCloudflareApi
	desired: BackupDesiredState
}): Promise<BackupResourcePlan> {
	const bucketName = input.desired.bucket.name
	const bucket = await input.api.getBucket(bucketName)
	let lockPolicy: R2LockPolicy | undefined
	let lifecyclePolicy: R2LifecyclePolicy | undefined
	if (bucket) {
		const policies = await Promise.all([
			input.api.getBucketLockPolicy(bucketName),
			input.api.getBucketLifecyclePolicy(bucketName),
		])
		lockPolicy = policies[0]
		lifecyclePolicy = policies[1]
	}
	const actions: Array<BackupPlanAction> = []
	if (!bucket) {
		actions.push({
			type: 'create-bucket',
			request: { name: bucketName },
		})
	}
	const effectiveLockPolicy = mergeLockPolicy(
		lockPolicy,
		input.desired.lockPolicy,
	)
	if (!samePolicy(lockPolicy, effectiveLockPolicy)) {
		actions.push({
			type: 'put-lock-policy',
			bucketName,
			request: effectiveLockPolicy,
		})
	}
	const effectiveLifecyclePolicy = mergeLifecyclePolicy(
		lifecyclePolicy,
		input.desired.lifecyclePolicy,
	)
	if (!samePolicy(lifecyclePolicy, effectiveLifecyclePolicy)) {
		actions.push({
			type: 'put-lifecycle-policy',
			bucketName,
			request: effectiveLifecyclePolicy,
		})
	}
	return {
		mode: 'plan',
		environment: 'production',
		desired: input.desired,
		actions,
	}
}

async function applyBackupAction(
	api: BackupCloudflareApi,
	action: BackupPlanAction,
) {
	switch (action.type) {
		case 'create-bucket': {
			await api.createBucket(action.request)
			return
		}
		case 'put-lock-policy': {
			await api.putBucketLockPolicy(action.bucketName, action.request)
			return
		}
		case 'put-lifecycle-policy': {
			await api.putBucketLifecyclePolicy(action.bucketName, action.request)
			return
		}
		default: {
			const exhaustiveAction: never = action
			throw new Error(`Unsupported backup action: ${String(exhaustiveAction)}`)
		}
	}
}

export function assertAdhocBackupPolicyReadback(input: {
	lockPolicy: R2LockPolicy | undefined
	lifecyclePolicy: R2LifecyclePolicy | undefined
}): AdhocBackupPolicyProof {
	const lockRule = input.lockPolicy?.rules.find(
		(rule) => rule.id === 'adhoc-backups-immutable-35-days',
	)
	const lifecycleRule = input.lifecyclePolicy?.rules.find(
		(rule) => rule.id === 'expire-adhoc-backups-after-35-days',
	)
	if (
		!lockRule?.enabled ||
		lockRule.prefix !== 'adhoc/' ||
		lockRule.condition.type !== 'Age' ||
		lockRule.condition.maxAgeSeconds < adhocRetentionSeconds ||
		!lifecycleRule?.enabled ||
		lifecycleRule.conditions.prefix !== 'adhoc/' ||
		lifecycleRule.deleteObjectsTransition?.condition?.type !== 'Age' ||
		lifecycleRule.deleteObjectsTransition.condition.maxAge <
			adhocRetentionSeconds
	) {
		throw new Error(
			'Cloudflare R2 adhoc/ lock and lifecycle read-back verification failed. Re-run `node tools/ci/backup-resources-cli.ts apply` with CLOUDFLARE_API_TOKEN set to the DR backup admin token, or set DR_BACKUP_ADMIN_TOKEN and re-run `node tools/ci/backup-resources-reconcile-cli.ts`.',
		)
	}
	return {
		prefix: 'adhoc/',
		lockRuleId: 'adhoc-backups-immutable-35-days',
		lockMinimumAgeSeconds: lockRule.condition.maxAgeSeconds,
		lifecycleRuleId: 'expire-adhoc-backups-after-35-days',
		lifecycleMinimumAgeSeconds:
			lifecycleRule.deleteObjectsTransition.condition.maxAge,
		readBackVerified: true,
	}
}

export async function ensureBackupResources(input: {
	api: BackupCloudflareApi
	desired: BackupDesiredState
	dryRun: boolean
	log?: (message: string) => void
}) {
	const plan = await planBackupResources(input)
	input.log?.(renderBackupOutput(plan))
	if (input.dryRun) {
		return { status: 'planned' as const, plan, appliedActions: 0 }
	}
	for (const action of plan.actions) {
		await applyBackupAction(input.api, action)
	}
	const bucketName = input.desired.bucket.name
	const [bucket, lockPolicy, lifecyclePolicy] = await Promise.all([
		input.api.getBucket(bucketName),
		input.api.getBucketLockPolicy(bucketName),
		input.api.getBucketLifecyclePolicy(bucketName),
	])
	const expectedLockPolicy =
		plan.actions.find(
			(
				action,
			): action is Extract<BackupPlanAction, { type: 'put-lock-policy' }> =>
				action.type === 'put-lock-policy',
		)?.request ?? mergeLockPolicy(lockPolicy, input.desired.lockPolicy)
	const expectedLifecyclePolicy =
		plan.actions.find(
			(
				action,
			): action is Extract<
				BackupPlanAction,
				{ type: 'put-lifecycle-policy' }
			> => action.type === 'put-lifecycle-policy',
		)?.request ??
		mergeLifecyclePolicy(lifecyclePolicy, input.desired.lifecyclePolicy)
	if (
		!bucket ||
		!samePolicy(lockPolicy, expectedLockPolicy) ||
		!samePolicy(lifecyclePolicy, expectedLifecyclePolicy)
	) {
		throw new Error(
			'Cloudflare R2 backup resources did not converge after apply.',
		)
	}
	const adhocPolicyProof = assertAdhocBackupPolicyReadback({
		lockPolicy,
		lifecyclePolicy,
	})
	return {
		status: 'applied' as const,
		plan,
		appliedActions: plan.actions.length,
		adhocPolicyProof,
	}
}

function parseEnvelope(payload: unknown, requestLabel: string) {
	if (
		!isRecord(payload) ||
		payload.success !== true ||
		!Object.hasOwn(payload, 'result')
	) {
		throw new Error(`Malformed Cloudflare response for ${requestLabel}.`)
	}
	return payload.result
}

function parseBucket(value: unknown, expectedName: string): R2Bucket {
	if (!isRecord(value) || value.name !== expectedName) {
		throw new Error('Malformed Cloudflare response for R2 bucket.')
	}
	if (
		(value.creation_date !== undefined &&
			typeof value.creation_date !== 'string') ||
		(value.jurisdiction !== undefined &&
			!['default', 'eu', 'fedramp'].includes(String(value.jurisdiction))) ||
		(value.location !== undefined &&
			!['apac', 'eeur', 'enam', 'weur', 'wnam', 'oc'].includes(
				String(value.location),
			)) ||
		(value.storage_class !== undefined &&
			!['Standard', 'InfrequentAccess'].includes(String(value.storage_class)))
	) {
		throw new Error('Malformed Cloudflare response for R2 bucket.')
	}
	return value as R2Bucket
}

function isLockRule(value: unknown) {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		typeof value.enabled !== 'boolean' ||
		(value.prefix !== undefined && typeof value.prefix !== 'string') ||
		!isRecord(value.condition)
	) {
		return false
	}
	const condition = value.condition
	switch (condition.type) {
		case 'Age':
			return (
				typeof condition.maxAgeSeconds === 'number' &&
				Number.isFinite(condition.maxAgeSeconds)
			)
		case 'Date':
			return typeof condition.date === 'string'
		case 'Indefinite':
			return true
		default:
			return false
	}
}

function parseLockPolicy(value: unknown): R2LockPolicy {
	if (
		!isRecord(value) ||
		(value.rules !== undefined &&
			(!Array.isArray(value.rules) || !value.rules.every(isLockRule)))
	) {
		throw new Error('Malformed Cloudflare response for R2 bucket lock.')
	}
	return { rules: (value.rules ?? []) as R2LockPolicy['rules'] }
}

function isLifecycleCondition(value: unknown, allowDate: boolean) {
	if (!isRecord(value)) return false
	switch (value.type) {
		case 'Age':
			return typeof value.maxAge === 'number' && Number.isFinite(value.maxAge)
		case 'Date':
			return allowDate && typeof value.date === 'string'
		default:
			return false
	}
}

function isLifecycleRule(value: unknown) {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		typeof value.enabled !== 'boolean' ||
		!isRecord(value.conditions) ||
		typeof value.conditions.prefix !== 'string'
	) {
		return false
	}
	if (
		value.deleteObjectsTransition !== undefined &&
		(!isRecord(value.deleteObjectsTransition) ||
			(value.deleteObjectsTransition.condition !== undefined &&
				!isLifecycleCondition(value.deleteObjectsTransition.condition, true)))
	) {
		return false
	}
	if (
		value.abortMultipartUploadsTransition !== undefined &&
		(!isRecord(value.abortMultipartUploadsTransition) ||
			(value.abortMultipartUploadsTransition.condition !== undefined &&
				!isLifecycleCondition(
					value.abortMultipartUploadsTransition.condition,
					false,
				)))
	) {
		return false
	}
	if (
		value.storageClassTransitions !== undefined &&
		(!Array.isArray(value.storageClassTransitions) ||
			!value.storageClassTransitions.every(
				(transition) =>
					isRecord(transition) &&
					transition.storageClass === 'InfrequentAccess' &&
					isLifecycleCondition(transition.condition, true),
			))
	) {
		return false
	}
	return true
}

function parseLifecyclePolicy(value: unknown): R2LifecyclePolicy {
	if (
		!isRecord(value) ||
		(value.rules !== undefined &&
			(!Array.isArray(value.rules) || !value.rules.every(isLifecycleRule)))
	) {
		throw new Error('Malformed Cloudflare response for R2 lifecycle.')
	}
	return { rules: (value.rules ?? []) as R2LifecyclePolicy['rules'] }
}

function cloudflareFailure(status: number, requestLabel: string) {
	let category = 'request rejected'
	if (status === 401) category = 'authentication rejected'
	else if (status === 403) category = 'authorization rejected'
	else if (status === 429) category = 'rate limited'
	else if (status >= 500) category = 'service unavailable'
	return new Error(
		`Cloudflare R2 ${requestLabel} failed (${status}): ${category}.`,
	)
}

export function createCloudflareBackupApi(input: {
	destinationAccountId: string
	apiToken: string
	fetcher?: typeof fetch
	apiBaseUrl?: string
}): BackupCloudflareApi {
	const destinationAccountId = normalizeCloudflareAccountId(
		input.destinationAccountId,
		'Destination Cloudflare account ID',
	)
	if (!input.apiToken)
		throw new Error('Cloudflare provisioner token is required.')
	const fetcher = input.fetcher ?? fetch
	const accountPath = `/accounts/${destinationAccountId}/r2/buckets`
	const baseUrl = (
		input.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4'
	).replace(/\/$/, '')

	async function request(
		method: 'GET' | 'POST' | 'PUT',
		pathname: string,
		requestLabel: string,
		body?: R2LockPolicy | R2LifecyclePolicy | { name: string },
		options?: { notFoundIsUndefined?: boolean },
	) {
		const response = await fetcher(`${baseUrl}${pathname}`, {
			method,
			headers: {
				Authorization: `Bearer ${input.apiToken}`,
				Accept: 'application/json',
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		})
		if (response.status === 404 && options?.notFoundIsUndefined) {
			return undefined
		}
		if (!response.ok) {
			throw cloudflareFailure(response.status, requestLabel)
		}
		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			throw new Error(`Malformed Cloudflare response for ${requestLabel}.`)
		}
		return parseEnvelope(payload, requestLabel)
	}

	return {
		async getBucket(name) {
			const result = await request(
				'GET',
				`${accountPath}/${encodeURIComponent(name)}`,
				'R2 bucket GET',
				undefined,
				{ notFoundIsUndefined: true },
			)
			return result === undefined ? undefined : parseBucket(result, name)
		},
		async createBucket(createInput) {
			const result = await request(
				'POST',
				accountPath,
				'R2 bucket POST',
				createInput,
			)
			return parseBucket(result, createInput.name)
		},
		async getBucketLockPolicy(bucketName) {
			const result = await request(
				'GET',
				`${accountPath}/${encodeURIComponent(bucketName)}/lock`,
				'R2 bucket lock GET',
				undefined,
				{ notFoundIsUndefined: true },
			)
			return result === undefined ? undefined : parseLockPolicy(result)
		},
		async putBucketLockPolicy(bucketName, policy) {
			await request(
				'PUT',
				`${accountPath}/${encodeURIComponent(bucketName)}/lock`,
				'R2 bucket lock PUT',
				policy,
			)
		},
		async getBucketLifecyclePolicy(bucketName) {
			const result = await request(
				'GET',
				`${accountPath}/${encodeURIComponent(bucketName)}/lifecycle`,
				'R2 lifecycle GET',
				undefined,
				{ notFoundIsUndefined: true },
			)
			return result === undefined ? undefined : parseLifecyclePolicy(result)
		},
		async putBucketLifecyclePolicy(bucketName, policy) {
			await request(
				'PUT',
				`${accountPath}/${encodeURIComponent(bucketName)}/lifecycle`,
				'R2 lifecycle PUT',
				policy,
			)
		},
	}
}

export function redactBackupOutput(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => redactBackupOutput(entry))
	}
	if (!isRecord(value)) return value
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			!nonSecretContractKeys.has(key) && sensitiveKeyPattern.test(key)
				? '[REDACTED]'
				: redactBackupOutput(entry),
		]),
	)
}

export function renderBackupOutput(value: unknown) {
	return JSON.stringify(redactBackupOutput(value), null, 2)
}
