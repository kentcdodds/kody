import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const explicitWebhookUrlSecretVerificationCodemodId =
	'0012-explicit-webhook-url-secret-verification'

const packageManifestPath = 'package.json'

const missingVerificationMessage =
	'Declares a kody.webhooks entry without verification; add verification: { "type": "url-secret" } (current behavior), or an HMAC type if the sender signs.'

const invalidJsonMessage =
	'package.json is missing or not valid JSON; review kody.webhooks manually.'

const invalidShapeMessage =
	'package.json#kody.webhooks is not an array of objects, or a webhook verification is not an object; review and update manually.'

type ManifestRecord = Record<string, unknown>

type WebhooksRewrite =
	| { kind: 'clean' }
	| { kind: 'rewrite'; parsed: ManifestRecord; source: string }
	| { kind: 'manual'; message: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseManifest(source: string): ManifestRecord | null {
	try {
		const parsed: unknown = JSON.parse(source)
		return isPlainObject(parsed) ? parsed : null
	} catch {
		return null
	}
}

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

function classifyPackageJson(files: Record<string, string>): WebhooksRewrite {
	const source = files[packageManifestPath]
	if (typeof source !== 'string') {
		return { kind: 'manual', message: invalidJsonMessage }
	}
	const parsed = parseManifest(source)
	if (!parsed) return { kind: 'manual', message: invalidJsonMessage }
	const kody = parsed['kody']
	if (kody === undefined) return { kind: 'clean' }
	if (!isPlainObject(kody)) {
		return { kind: 'manual', message: invalidShapeMessage }
	}
	const webhooks = kody['webhooks']
	if (webhooks === undefined) return { kind: 'clean' }
	if (!Array.isArray(webhooks) || !webhooks.every(isPlainObject)) {
		return { kind: 'manual', message: invalidShapeMessage }
	}
	let missing = false
	for (const webhook of webhooks) {
		if (!('verification' in webhook)) {
			missing = true
		} else if (!isPlainObject(webhook['verification'])) {
			return { kind: 'manual', message: invalidShapeMessage }
		}
	}
	return missing ? { kind: 'rewrite', parsed, source } : { kind: 'clean' }
}

function detectExplicitWebhookUrlSecretVerification(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const rewrite = classifyPackageJson(files)
	switch (rewrite.kind) {
		case 'clean':
			return []
		case 'rewrite':
			return [
				{ path: packageManifestPath, message: missingVerificationMessage },
			]
		case 'manual':
			return [{ path: packageManifestPath, message: rewrite.message }]
		default: {
			const exhaustive: never = rewrite
			return exhaustive
		}
	}
}

function transformExplicitWebhookUrlSecretVerification(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const rewrite = classifyPackageJson(files)
	switch (rewrite.kind) {
		case 'clean':
			return {
				files: { ...files },
				changed: false,
				changedPaths: [],
				needsManual: [],
			}
		case 'manual':
			return {
				files: { ...files },
				changed: false,
				changedPaths: [],
				needsManual: [{ path: packageManifestPath, message: rewrite.message }],
			}
		case 'rewrite': {
			const kody = rewrite.parsed['kody'] as ManifestRecord
			const webhooks = kody['webhooks'] as Array<ManifestRecord>
			const next = {
				...rewrite.parsed,
				kody: {
					...kody,
					webhooks: webhooks.map((webhook) =>
						'verification' in webhook
							? webhook
							: { ...webhook, verification: { type: 'url-secret' } },
					),
				},
			}
			return {
				files: {
					...files,
					[packageManifestPath]: `${JSON.stringify(next, null, detectJsonIndent(rewrite.source))}\n`,
				},
				changed: true,
				changedPaths: [packageManifestPath],
				needsManual: [],
			}
		}
		default: {
			const exhaustive: never = rewrite
			return exhaustive
		}
	}
}

/**
 * Manifest-format migration: give every `kody.webhooks` entry that declares no
 * `verification` the explicit `{ "type": "url-secret" }` it already gets at
 * ingress, so publish can require `verification`. Zero behavior change.
 * https://github.com/kentcdodds/kody/issues/3477
 */
export const explicitWebhookUrlSecretVerificationCodemod = {
	id: explicitWebhookUrlSecretVerificationCodemodId,
	description:
		'Add verification: { "type": "url-secret" } to package.json#kody.webhooks entries that declare no verification (what ingress already does for them).',
	// Fleet apply must advance published_commit on drifted packages without
	// clobbering owner unpublished HEAD (issue #3477 rollout).
	applyMode: 'published-only',
	detect: detectExplicitWebhookUrlSecretVerification,
	transform: transformExplicitWebhookUrlSecretVerification,
} satisfies PackageCodemod
