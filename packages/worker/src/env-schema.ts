import { aiModeValues } from '@kody-internal/shared/chat.ts'
import {
	createSchema,
	fail,
	object,
	string,
	type InferOutput,
} from 'remix/data-schema'

const d1DatabaseSchema = createSchema<unknown, D1Database>((value, context) => {
	if (value) {
		return { value: value as D1Database }
	}
	return fail('Missing APP_DB binding for database access.', context.path)
})

const optionalNonEmptyStringSchema = createSchema<unknown, string | undefined>(
	(value, context) => {
		if (value === undefined) return { value: undefined }
		if (typeof value !== 'string') return fail('Expected string', context.path)

		const trimmed = value.trim()
		return { value: trimmed.length > 0 ? trimmed : undefined }
	},
)

const optionalUrlStringSchema = createSchema<unknown, string | undefined>(
	(value, context) => {
		if (value === undefined) return { value: undefined }
		if (typeof value !== 'string') return fail('Expected string', context.path)

		const trimmed = value.trim()
		if (!trimmed) return { value: undefined }

		try {
			new URL(trimmed)
			return { value: trimmed }
		} catch {
			return fail('Expected valid URL', context.path)
		}
	},
)

const optionalCommitShaSchema = createSchema<unknown, string | undefined>(
	(value, context) => {
		if (value === undefined) return { value: undefined }
		if (typeof value !== 'string') return fail('Expected string', context.path)

		const trimmed = value.trim()
		if (!trimmed) return { value: undefined }
		if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) {
			return fail(
				'Expected commit SHA (7-40 hexadecimal characters)',
				context.path,
			)
		}

		return { value: trimmed.toLowerCase() }
	},
)

const optionalAiModeSchema = createSchema<
	unknown,
	(typeof aiModeValues)[number] | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value !== 'string') return fail('Expected string', context.path)

	const trimmed = value.trim()
	if (!trimmed) return { value: undefined }
	if (aiModeValues.includes(trimmed as (typeof aiModeValues)[number])) {
		return { value: trimmed as (typeof aiModeValues)[number] }
	}
	return fail(`Expected one of: ${aiModeValues.join(', ')}`, context.path)
})

const optionalRemoteConnectorSecretsSchema = createSchema<
	unknown,
	Record<string, string> | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value !== 'string') return fail('Expected string', context.path)

	const trimmed = value.trim()
	if (!trimmed) return { value: undefined }

	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		return fail(
			'REMOTE_CONNECTOR_SECRETS must be valid JSON when set.',
			context.path,
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return fail(
			'REMOTE_CONNECTOR_SECRETS must be a JSON object mapping "kind:instanceId" keys to secret strings.',
			context.path,
		)
	}

	const out: Record<string, string> = {}
	for (const [rawKey, rawVal] of Object.entries(parsed)) {
		const key = rawKey.trim()
		const colon = key.indexOf(':')
		if (colon <= 0 || colon === key.length - 1) {
			return fail(
				`REMOTE_CONNECTOR_SECRETS has invalid key "${rawKey}" (expected "kind:instanceId").`,
				context.path,
			)
		}
		const kind = key.slice(0, colon).trim().toLowerCase()
		const instanceId = key.slice(colon + 1).trim()
		if (!kind || !instanceId) {
			return fail(
				`REMOTE_CONNECTOR_SECRETS has invalid key "${rawKey}" (kind and instanceId must be non-empty).`,
				context.path,
			)
		}
		const canonicalKey = `${kind}:${instanceId}`
		if (typeof rawVal !== 'string' || !rawVal.trim()) {
			return fail(
				`REMOTE_CONNECTOR_SECRETS value for "${canonicalKey}" must be a non-empty string.`,
				context.path,
			)
		}
		out[canonicalKey] = rawVal.trim()
	}
	return { value: out }
})

export type PackageInvocationTokenConfig = {
	token: string
	userId: string
	email: string
	displayName: string
	packageIds?: Array<string>
	packageKodyIds?: Array<string>
	exportNames?: Array<string>
	sources?: Array<string>
}

export type PackageInvocationTokensConfig = Record<
	string,
	PackageInvocationTokenConfig
>

const optionalPackageInvocationTokensSchema = createSchema<
	unknown,
	PackageInvocationTokensConfig | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value !== 'string') return fail('Expected string', context.path)

	const trimmed = value.trim()
	if (!trimmed) return { value: undefined }

	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		return fail(
			'PACKAGE_INVOCATION_TOKENS must be valid JSON when set.',
			context.path,
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return fail(
			'PACKAGE_INVOCATION_TOKENS must be a JSON object mapping token ids to scoped token configs.',
			context.path,
		)
	}

	const normalizeOptionalStringArray = (
		rawValue: unknown,
		field: string,
		tokenId: string,
	) => {
		if (rawValue === undefined) return undefined
		if (!Array.isArray(rawValue)) {
			throw new Error(
				`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" field "${field}" must be an array of non-empty strings.`,
			)
		}
		const normalized = rawValue
			.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
			.filter((entry) => entry.length > 0)
		if (normalized.length !== rawValue.length) {
			throw new Error(
				`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" field "${field}" must contain only non-empty strings.`,
			)
		}
		return normalized.length > 0 ? normalized : undefined
	}

	const out: PackageInvocationTokensConfig = {}
	for (const [rawTokenId, rawTokenConfig] of Object.entries(parsed)) {
		const tokenId = rawTokenId.trim()
		if (!tokenId) {
			return fail(
				'PACKAGE_INVOCATION_TOKENS keys must be non-empty token ids.',
				context.path,
			)
		}
		if (
			!rawTokenConfig ||
			typeof rawTokenConfig !== 'object' ||
			Array.isArray(rawTokenConfig)
		) {
			return fail(
				`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" must be an object.`,
				context.path,
			)
		}

		try {
			const record = rawTokenConfig as Record<string, unknown>
			const token =
				typeof record['token'] === 'string' ? record['token'].trim() : ''
			const userId =
				typeof record['userId'] === 'string' ? record['userId'].trim() : ''
			const email =
				typeof record['email'] === 'string' ? record['email'].trim() : ''
			const displayName =
				typeof record['displayName'] === 'string'
					? record['displayName'].trim()
					: ''
			const packageIds = normalizeOptionalStringArray(
				record['packageIds'],
				'packageIds',
				tokenId,
			)
			const packageKodyIds = normalizeOptionalStringArray(
				record['packageKodyIds'],
				'packageKodyIds',
				tokenId,
			)
			const exportNames = normalizeOptionalStringArray(
				record['exportNames'],
				'exportNames',
				tokenId,
			)
			const sources = normalizeOptionalStringArray(
				record['sources'],
				'sources',
				tokenId,
			)

			if (!token) {
				return fail(
					`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" requires a non-empty "token" string.`,
					context.path,
				)
			}
			if (!userId) {
				return fail(
					`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" requires a non-empty "userId" string.`,
					context.path,
				)
			}
			if (!email) {
				return fail(
					`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" requires a non-empty "email" string.`,
					context.path,
				)
			}
			if (!displayName) {
				return fail(
					`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" requires a non-empty "displayName" string.`,
					context.path,
				)
			}
			if (!packageIds && !packageKodyIds) {
				return fail(
					`PACKAGE_INVOCATION_TOKENS entry "${tokenId}" must declare at least one package scope via "packageIds" or "packageKodyIds".`,
					context.path,
				)
			}

			out[tokenId] = {
				token,
				userId,
				email,
				displayName,
				...(packageIds ? { packageIds } : {}),
				...(packageKodyIds ? { packageKodyIds } : {}),
				...(exportNames ? { exportNames } : {}),
				...(sources ? { sources } : {}),
			}
		} catch (error) {
			return fail(
				error instanceof Error
					? error.message
					: `Invalid PACKAGE_INVOCATION_TOKENS entry "${tokenId}".`,
				context.path,
			)
		}
	}

	return { value: out }
})

const optionalSentryTracesSampleRateSchema = createSchema<
	unknown,
	number | undefined
>((value, context) => {
	if (value === undefined) return { value: undefined }
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			return fail(
				'SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1',
				context.path,
			)
		}
		return { value }
	}
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (!trimmed) return { value: undefined }
		const n = Number.parseFloat(trimmed)
		if (!Number.isFinite(n) || n < 0 || n > 1) {
			return fail(
				'SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1',
				context.path,
			)
		}
		return { value: n }
	}
	return fail('Expected number or numeric string', context.path)
})

export const EnvSchema = object({
	COOKIE_SECRET: string().refine(
		(value) => value.length >= 32,
		'COOKIE_SECRET must be at least 32 characters for session signing.',
	),
	APP_DB: d1DatabaseSchema,
	BUNDLE_ARTIFACTS_KV: createSchema<unknown, KVNamespace>((value, context) => {
		if (value) {
			return { value: value as KVNamespace }
		}
		return fail(
			'Missing BUNDLE_ARTIFACTS_KV binding for published runtime artifacts.',
			context.path,
		)
	}),
	JOB_MANAGER: createSchema<unknown, DurableObjectNamespace>(
		(value, context) => {
			if (value) {
				return { value: value as DurableObjectNamespace }
			}
			return fail(
				'Missing JOB_MANAGER binding for jobs scheduling.',
				context.path,
			)
		},
	),
	STORAGE_RUNNER: createSchema<unknown, DurableObjectNamespace>(
		(value, context) => {
			if (value) {
				return { value: value as DurableObjectNamespace }
			}
			return fail(
				'Missing STORAGE_RUNNER binding for durable execute and job storage.',
				context.path,
			)
		},
	),
	PACKAGE_REALTIME_SESSION: createSchema<unknown, DurableObjectNamespace>(
		(value, context) => {
			if (value) {
				return { value: value as DurableObjectNamespace }
			}
			return fail(
				'Missing PACKAGE_REALTIME_SESSION binding for package realtime websocket sessions.',
				context.path,
			)
		},
	),
	PACKAGE_SERVICE_INSTANCE: createSchema<unknown, DurableObjectNamespace>(
		(value, context) => {
			if (value) {
				return { value: value as DurableObjectNamespace }
			}
			return fail(
				'Missing PACKAGE_SERVICE_INSTANCE binding for package service runtimes.',
				context.path,
			)
		},
	),
	APP_BASE_URL: optionalUrlStringSchema,
	APP_COMMIT_SHA: optionalCommitShaSchema,
	CLOUDFLARE_EMAIL_FROM: optionalNonEmptyStringSchema,
	AI_MODE: optionalAiModeSchema,
	AI_MODEL: optionalNonEmptyStringSchema,
	AI_GATEWAY_ID: optionalNonEmptyStringSchema,
	AI_MOCK_BASE_URL: optionalUrlStringSchema,
	AI_MOCK_API_KEY: optionalNonEmptyStringSchema,
	SENTRY_DSN: optionalUrlStringSchema,
	SENTRY_ENVIRONMENT: optionalNonEmptyStringSchema,
	SENTRY_TRACES_SAMPLE_RATE: optionalSentryTracesSampleRateSchema,
	CLOUDFLARE_ACCOUNT_ID: optionalNonEmptyStringSchema,
	CLOUDFLARE_API_TOKEN: optionalNonEmptyStringSchema,
	CLOUDFLARE_API_BASE_URL: optionalUrlStringSchema,
	CAPABILITY_REINDEX_SECRET: optionalNonEmptyStringSchema,
	JOB_REINDEX_SECRET: optionalNonEmptyStringSchema,
	PACKAGE_INVOCATION_TOKENS: optionalPackageInvocationTokensSchema,
	HOME_CONNECTOR_SHARED_SECRET: optionalNonEmptyStringSchema,
	REMOTE_CONNECTOR_SECRETS: optionalRemoteConnectorSecretsSchema,
})

export type AppEnv = InferOutput<typeof EnvSchema>
