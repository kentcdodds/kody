import {
	createSchema,
	fail,
	object,
	string,
	type InferOutput,
} from 'remix/data-schema'
import { signupModes, type SignupMode } from '#universal/signup-mode.ts'

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

const optionalArtifactsSchema = createSchema<unknown, Artifacts | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Artifacts }
	},
)

// Service binding to the package runtime Worker (`kody-runtime`). Present in
// production/preview and multi-worker local dev; absent in tests and
// single-worker dev, where the main Worker serves the runtime lane itself.
const optionalFetcherSchema = createSchema<unknown, Fetcher | undefined>(
	(value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Fetcher }
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

const signupModeSchema = createSchema<unknown, SignupMode>((value, context) => {
	if (value === undefined || value === '') return { value: 'invite' }
	if (typeof value === 'string' && signupModes.includes(value as SignupMode)) {
		return { value: value as SignupMode }
	}
	return fail(
		`SIGNUP_MODE must be one of: ${signupModes.join(', ')}`,
		context.path,
	)
})

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
	// Jobs worker service binding (ADR 0016). Optional: tests and local
	// single-worker dev fall back to jobs tables in APP_DB and skip
	// JobManager alarm scheduling.
	JOBS: createSchema<unknown, Fetcher | undefined>((value, _context) => {
		if (value === undefined) return { value: undefined }
		return { value: value as Fetcher }
	}),
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
	RUNTIME_WORKER: optionalFetcherSchema,
	APP_BASE_URL: optionalUrlStringSchema,
	// Comma-separated legacy app hostnames (for example `heykody.dev`) the
	// Worker keeps serving alongside the canonical `APP_BASE_URL` host during
	// a domain migration. The deploy attaches these as custom domains so
	// flipping APP_BASE_URL never detaches the old origin or deletes its DNS.
	APP_LEGACY_HOSTS: optionalNonEmptyStringSchema,
	// Exact string 'true' enables 308 redirects from legacy hosts to the
	// canonical origin for safe browser GET/HEAD requests. Protocol surfaces
	// (/mcp, OAuth, well-known, webhooks, email) are never redirected. Leave
	// unset to dual-serve legacy hosts without redirecting browser navigation.
	APP_LEGACY_REDIRECT: optionalNonEmptyStringSchema,
	// Public account creation posture. `invite` is the safe default; switching
	// to `open` is an explicit deployment configuration change.
	SIGNUP_MODE: signupModeSchema,
	// Turnstile remains disabled unless both keys are configured, preserving
	// local development, preview deployments, and tests.
	TURNSTILE_SITE_KEY: optionalNonEmptyStringSchema,
	TURNSTILE_SECRET_KEY: optionalNonEmptyStringSchema,
	// Origin that hosted package apps are served from. Required in production
	// and must use a separate registrable domain so author-supplied package code
	// is cross-site from the app origin. It may be unset locally/preview/test,
	// where the same-origin path-based behavior remains available.
	// See docs/contributing/security.md.
	PACKAGE_APP_BASE_URL: optionalUrlStringSchema,
	// Comma-separated previous package-app apex hostnames (for example
	// `kodyapps.dev`) the runtime Worker keeps serving alongside the
	// canonical `PACKAGE_APP_BASE_URL` host during a domain migration.
	// Generated zone routes replace the whole set, so omitting a listed
	// host would detach it and delete its DNS.
	PACKAGE_APP_LEGACY_HOSTS: optionalNonEmptyStringSchema,
	// Exact string 'true' enables 308 redirects from legacy package-app
	// *user subdomains* to the matching canonical subdomain for safe
	// browser GET/HEAD. Leave unset to dual-serve (required while
	// `__Host-kody_pkg_session` cookies and published package URLs still
	// live on the old host). Apex `/` on a legacy package-app host still
	// goes to the app origin; it is never redirected onto the canonical
	// package-app apex.
	PACKAGE_APP_LEGACY_REDIRECT: optionalNonEmptyStringSchema,
	USER_EMAIL_DOMAIN: optionalNonEmptyStringSchema,
	// Overrides the system email domain derived from APP_BASE_URL. Committed
	// in production so email and the web origin can move independently.
	SYSTEM_EMAIL_DOMAIN: optionalNonEmptyStringSchema,
	// Comma-separated previous user email domains (for example
	// inbox.heykody.dev) that inbound mail is still accepted on during a
	// domain migration; delivery resolves to the same user inboxes. Outbound
	// always sends from the canonical USER_EMAIL_DOMAIN.
	LEGACY_USER_EMAIL_DOMAINS: optionalNonEmptyStringSchema,
	// Comma-separated previous system email domains (for example
	// heykody.dev) that operator inboxes (kody@, support@, ...) keep
	// receiving on during a domain migration.
	LEGACY_SYSTEM_EMAIL_DOMAINS: optionalNonEmptyStringSchema,
	APP_COMMIT_SHA: optionalCommitShaSchema,
	EMAIL: optionalSendEmailSchema,
	EMAIL_EVENTS: optionalAnalyticsEngineDatasetSchema,
	USAGE_EVENTS: optionalAnalyticsEngineDatasetSchema,
	FLAG_EXPOSURES: optionalAnalyticsEngineDatasetSchema,
	MCP_PROTOCOL_EVENTS: optionalAnalyticsEngineDatasetSchema,
	SENTRY_DSN: optionalUrlStringSchema,
	SENTRY_ENVIRONMENT: optionalNonEmptyStringSchema,
	SENTRY_TRACES_SAMPLE_RATE: optionalSentryTracesSampleRateSchema,
	// Fathom Analytics site id (public, non-secret). When set, SSR pages embed
	// the Fathom tracker script; when unset (local dev, preview, tests) no
	// analytics script is rendered.
	FATHOM_SITE_ID: optionalNonEmptyStringSchema,
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
	// Worker-to-Worker Artifacts binding. Present in production/preview when
	// wrangler `artifacts` is configured; local/tests fall back to REST.
	ARTIFACTS: optionalArtifactsSchema,
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
	// Stripe platform webhook signing secret (`whsec_...`). When unset,
	// POST /webhooks/stripe returns 503.
	STRIPE_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
	// Override for tests/mocks; defaults to https://api.stripe.com.
	STRIPE_API_BASE_URL: optionalUrlStringSchema,
	STRIPE_STANDARD_PRICE_ID: optionalNonEmptyStringSchema,
	STRIPE_STANDARD_YEARLY_PRICE_ID: optionalNonEmptyStringSchema,
	STRIPE_PRO_PRICE_ID: optionalNonEmptyStringSchema,
	STRIPE_PRO_YEARLY_PRICE_ID: optionalNonEmptyStringSchema,
	// Disaster-recovery exporter → DR-account R2 bucket (S3 API). Disabled
	// unless DR_EXPORT_ENABLED is the literal string "true" and credentials
	// are present. Secrets are set out-of-band via the Cloudflare API.
	DR_EXPORT_ENABLED: optionalNonEmptyStringSchema,
	DR_BACKUP_ACCOUNT_ID: optionalNonEmptyStringSchema,
	DR_BACKUP_BUCKET_NAME: optionalNonEmptyStringSchema,
	DR_BACKUP_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
	DR_BACKUP_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
	// Bearer secret for production DR restore and DO PITR maintenance routes.
	// Both fail closed when unset.
	DR_RESTORE_SECRET: optionalNonEmptyStringSchema,
})

export type AppEnv = InferOutput<typeof EnvSchema>
