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

function requiredDurableObjectNamespaceSchema(message: string) {
	return createSchema<unknown, DurableObjectNamespace>((value, context) => {
		if (value) {
			return { value: value as DurableObjectNamespace }
		}
		return fail(message, context.path)
	})
}

const optionalSendEmailSchema = createSchema<unknown, SendEmail | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as SendEmail }
	},
)

const optionalAnalyticsEngineDatasetSchema = createSchema<
	unknown,
	AnalyticsEngineDataset | undefined
>((value, _context) => {
	if (value === undefined) return { value: undefined }
	return { value: value as AnalyticsEngineDataset }
})

const optionalAiSchema = createSchema<unknown, Ai | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Ai }
	},
)

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

const secretStoreKeySchema = createSchema<unknown, string>((value, context) => {
	if (typeof value !== 'string') {
		return fail(
			'Missing SECRET_STORE_KEY binding for saved secret encryption.',
			context.path,
		)
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return fail(
			'Missing SECRET_STORE_KEY binding for saved secret encryption.',
			context.path,
		)
	}
	if (trimmed.length < 32) {
		return fail(
			'SECRET_STORE_KEY must be at least 32 characters for secure key derivation.',
			context.path,
		)
	}
	return { value: trimmed }
})

export const EnvSchema = object({
	COOKIE_SECRET: string().refine(
		(value) => value.length >= 32,
		'COOKIE_SECRET must be at least 32 characters for session signing.',
	),
	SECRET_STORE_KEY: secretStoreKeySchema,
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
	JOB_MANAGER: requiredDurableObjectNamespaceSchema(
		'Missing JOB_MANAGER binding for jobs scheduling.',
	),
	STORAGE_RUNNER: requiredDurableObjectNamespaceSchema(
		'Missing STORAGE_RUNNER binding for durable execute and job storage.',
	),
	PACKAGE_REALTIME_SESSION: requiredDurableObjectNamespaceSchema(
		'Missing PACKAGE_REALTIME_SESSION binding for package realtime websocket sessions.',
	),
	PACKAGE_SERVICE_INSTANCE: requiredDurableObjectNamespaceSchema(
		'Missing PACKAGE_SERVICE_INSTANCE binding for package service runtimes.',
	),
	MCP_CLIENT_HUB: requiredDurableObjectNamespaceSchema(
		'Missing MCP_CLIENT_HUB binding for user-added MCP server connections.',
	),
	APP_BASE_URL: optionalUrlStringSchema,
	USER_EMAIL_DOMAIN: optionalNonEmptyStringSchema,
	APP_COMMIT_SHA: optionalCommitShaSchema,
	EMAIL: optionalSendEmailSchema,
	USAGE_EVENTS: optionalAnalyticsEngineDatasetSchema,
	SENTRY_DSN: optionalUrlStringSchema,
	SENTRY_ENVIRONMENT: optionalNonEmptyStringSchema,
	SENTRY_TRACES_SAMPLE_RATE: optionalSentryTracesSampleRateSchema,
	WRANGLER_IS_LOCAL_DEV: optionalNonEmptyStringSchema,
	GITHUB_CLIENT_ID: optionalNonEmptyStringSchema,
	GITHUB_CLIENT_SECRET: optionalNonEmptyStringSchema,
	GOOGLE_CLIENT_ID: optionalNonEmptyStringSchema,
	GOOGLE_CLIENT_SECRET: optionalNonEmptyStringSchema,
	X_CLIENT_ID: optionalNonEmptyStringSchema,
	X_CLIENT_SECRET: optionalNonEmptyStringSchema,
	CLOUDFLARE_ACCOUNT_ID: optionalNonEmptyStringSchema,
	CLOUDFLARE_API_TOKEN: optionalNonEmptyStringSchema,
	CLOUDFLARE_API_BASE_URL: optionalUrlStringSchema,
	ARTIFACTS_NAMESPACE: optionalNonEmptyStringSchema,
	AI: optionalAiSchema,
	AI_GATEWAY_ID: optionalNonEmptyStringSchema,
	CAPABILITY_REINDEX_SECRET: optionalNonEmptyStringSchema,
	JOB_REINDEX_SECRET: optionalNonEmptyStringSchema,
	// Kit (kit.com) waitlist — optional; production waiting-list submits fail
	// closed without KIT_API_KEY. Non-production skips Kit when unset.
	// Account signup also uses KIT_API_KEY to best-effort tag existing Kit
	// subscribers with signed_up::kody (never creates subscribers; never fails
	// signup when Kit is unset or errors).
	KIT_API_KEY: optionalNonEmptyStringSchema,
	KIT_WAITLIST_TAG_ID: optionalNonEmptyStringSchema,
	KIT_WAITLIST_SEQUENCE_ID: optionalNonEmptyStringSchema,
	KIT_SIGNED_UP_TAG_ID: optionalNonEmptyStringSchema,
	// Stripe billing — optional; when STRIPE_SECRET_KEY is unset, billing
	// surfaces render a "not configured" notice and sync/cron/portal skip.
	STRIPE_SECRET_KEY: optionalNonEmptyStringSchema,
	// Override for tests/mocks; defaults to https://api.stripe.com.
	STRIPE_API_BASE_URL: optionalUrlStringSchema,
	STRIPE_PRO_PRICE_ID: optionalNonEmptyStringSchema,
	// Disaster-recovery exporter → DR-account R2 bucket (S3 API). Disabled
	// unless DR_EXPORT_ENABLED is the literal string "true" and credentials
	// are present. Secrets are set out-of-band via the Cloudflare API.
	DR_EXPORT_ENABLED: optionalNonEmptyStringSchema,
	DR_BACKUP_ACCOUNT_ID: optionalNonEmptyStringSchema,
	DR_BACKUP_BUCKET_NAME: optionalNonEmptyStringSchema,
	DR_BACKUP_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
	DR_BACKUP_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
	// Bearer secret for POST /__maintenance/dr-restore. Fail-closed when unset.
	DR_RESTORE_SECRET: optionalNonEmptyStringSchema,
})

export type AppEnv = InferOutput<typeof EnvSchema>
