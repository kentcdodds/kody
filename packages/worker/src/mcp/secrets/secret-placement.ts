/**
 * Where the fetch gateway may substitute a credential (credentials plan v4,
 * open call 15). Checked before any credential resolves:
 *
 * - every placeholder sits in a request header, never the URL or query;
 * - the body holds no placeholder: it is never a substitution site, so the
 *   gateway refuses rather than send the reference upstream unsubstituted
 *   (an allowed body is forwarded byte for byte);
 * - the request is HTTPS;
 * - in a package that declares `kody.credentials`, each placeholder names a
 *   slot of the matching kind and sits in that slot's declared header, with the
 *   header value matching the slot's template.
 *
 * Host allowlists are checked separately, per credential, after resolution.
 */
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	credentialPlacementRefusedCode,
	formatCredentialPlacementRefusalTag,
} from '#worker/credentials/placement-refusal.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	credentialSlotPlacement,
	type PackageCredentialSlot,
} from '#worker/package-registry/types.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildIntegrationTokenPlaceholder,
	buildProviderSecretPlaceholder,
	buildSecretPlaceholder,
	parseBasicAuthSecretPlaceholders,
	parseIntegrationTokenPlaceholders,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
} from './placeholders.ts'

/**
 * The message ends with a `(credential_placement_refused, slot "…")` tag so
 * the cause survives the sandbox boundary, where only the message crosses.
 */
export class SecretPlacementError extends McpCallerError {
	readonly code = credentialPlacementRefusedCode
	readonly slot: string | null
	constructor(message: string, slot: string | null) {
		super(`${message} ${formatCredentialPlacementRefusalTag(slot)}`)
		this.name = 'SecretPlacementError'
		this.slot = slot
	}
}

/**
 * The slots that govern placement. `undeclared` covers ad-hoc code and
 * packages without `kody.credentials`: any header is allowed.
 */
export type SecretPlacementPolicy =
	| { kind: 'undeclared' }
	| {
			kind: 'declared'
			packageName: string
			slots: Readonly<Record<string, PackageCredentialSlot>>
			/** Slots the published snapshot declares but that failed to load. */
			invalidSlots?: Readonly<Record<string, string>>
	  }

const policyCache = new WeakMap<
	object,
	Map<string, Promise<SecretPlacementPolicy>>
>()

/**
 * The placement policy for the package a fetch is stamped with, read from its
 * published manifest. Cached per run (`cacheKey`, the run's request context)
 * so a run's many fetches read the manifest once.
 */
export async function loadSecretPlacementPolicy(input: {
	env: Env
	baseUrl: string
	packageId: string | null | undefined
	cacheKey: object | null
}): Promise<SecretPlacementPolicy> {
	const packageId = input.packageId?.trim()
	if (!packageId) return { kind: 'undeclared' }
	const runCache = input.cacheKey
		? (policyCache.get(input.cacheKey) ?? new Map())
		: new Map<string, Promise<SecretPlacementPolicy>>()
	if (input.cacheKey) policyCache.set(input.cacheKey, runCache)
	let pending = runCache.get(packageId)
	if (!pending) {
		pending = readSecretPlacementPolicy(input.env, input.baseUrl, packageId)
		runCache.set(packageId, pending)
		pending.catch(() => runCache.delete(packageId))
	}
	return await pending
}

async function readSecretPlacementPolicy(
	env: Env,
	baseUrl: string,
	packageId: string,
): Promise<SecretPlacementPolicy> {
	const savedPackage = await getSavedPackageByIdInAnyOrg(env.APP_DB, packageId)
	if (!savedPackage) {
		throw new SecretPlacementError(
			`Package "${packageId}" was not found, so the fetch gateway cannot check where its credential slots may be sent.`,
			null,
		)
	}
	const loaded = await loadPackageManifestBySourceId({
		env,
		baseUrl,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
	})
	const { credentials: slots, invalidCredentialSlots } = loaded.manifest.kody
	return slots
		? {
				kind: 'declared',
				packageName: savedPackage.name,
				slots,
				invalidSlots: invalidCredentialSlots,
			}
		: { kind: 'undeclared' }
}

type PlacedReference =
	| { kind: 'secret'; name: string; placeholder: string }
	| {
			kind: 'secret-basic'
			usernameName: string
			passwordName: string
			placeholder: string
	  }
	| { kind: 'integration-token'; name: string; placeholder: string }
	| { kind: 'provider-secret'; provider: string; placeholder: string }

const headerRuleHint =
	'The fetch gateway substitutes a secret only into a request header, never the URL, query, or body.'

const bodyRuleHint =
	'The fetch gateway never substitutes a secret into a request body, and it will not send an unsubstituted placeholder upstream.'

/**
 * Percent-decodes the punctuation of every placeholder form, so a reference
 * built with `URLSearchParams` (`%7B%7Bsecret%3Aname%7D%7D`) is still found.
 */
function decodePlaceholderPunctuation(value: string) {
	return value.replaceAll(/%(7B|7D|3A|2F|3D|2C|7C)/gi, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	)
}

function referencesIn(value: string): PlacedReference[] {
	return [
		...parseSecretPlaceholders(value).map((secret) => ({
			kind: 'secret' as const,
			name: secret.name,
			placeholder: buildSecretPlaceholder(secret),
		})),
		...parseBasicAuthSecretPlaceholders(value).map((basic) => ({
			kind: 'secret-basic' as const,
			usernameName: basic.username.name,
			passwordName: basic.password.name,
			placeholder: buildBasicAuthSecretPlaceholderFromReference(basic),
		})),
		...parseIntegrationTokenPlaceholders(value).map((name) => ({
			kind: 'integration-token' as const,
			name,
			placeholder: buildIntegrationTokenPlaceholder(name),
		})),
		...parseProviderSecretPlaceholders(value).map((provider) => ({
			kind: 'provider-secret' as const,
			provider: provider.provider,
			placeholder: buildProviderSecretPlaceholder(provider),
		})),
	]
}

/** The slot a reference names; vault references name a provider, not a slot. */
/**
 * The one slot a refusal is about. A Basic Auth pair names two slots, so a
 * refusal of the whole pair names neither; per-slot checks pass their own.
 */
function slotOf(reference: PlacedReference) {
	switch (reference.kind) {
		case 'secret':
		case 'integration-token':
			return reference.name
		case 'secret-basic':
		case 'provider-secret':
			return null
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
		}
	}
}

function describeReference(reference: PlacedReference) {
	switch (reference.kind) {
		case 'secret':
			return `Secret "${reference.name}"`
		case 'secret-basic':
			return `Basic auth secret pair "${reference.usernameName}" / "${reference.passwordName}"`
		case 'integration-token':
			return `Integration token "${reference.name}"`
		case 'provider-secret':
			return `Vault secret from "${reference.provider}"`
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
		}
	}
}

function refuseOutsideHeader(reference: PlacedReference, location: string) {
	return new SecretPlacementError(
		`${describeReference(reference)} is in the request ${location}. ${headerRuleHint} Send it in a header instead, for example headers: { Authorization: 'Bearer ${reference.placeholder}' }.`,
		slotOf(reference),
	)
}

/** True when `value` is exactly `template` with the placeholder for `{value}`. */
function headerValueMatchesTemplate(
	value: string,
	template: string,
	placeholder: string,
) {
	return value.trim() === template.replace('{value}', () => placeholder).trim()
}

/** The gateway builds the whole `Basic …` value; these are the forms it fills. */
function isDerivedBasicAuthValue(value: string, placeholder: string) {
	const trimmed = value.trim()
	return (
		trimmed === placeholder ||
		['Basic', 'basic', 'BASIC'].some(
			(scheme) => trimmed === `${scheme} ${placeholder}`,
		)
	)
}

const basicAuthTemplate = 'Basic {value}'

function assertDeclaredSlotPlacement(input: {
	policy: Extract<SecretPlacementPolicy, { kind: 'declared' }>
	slotName: string
	expectedKind: 'secret' | 'oauth'
	headerName: string
	headerValue: string
	placeholder: string
	/** `basic`: one of a Basic Auth pair the gateway encodes into one value. */
	use: 'slot' | 'basic'
}) {
	const { policy, slotName, headerName } = input
	const slot = Object.hasOwn(policy.slots, slotName)
		? policy.slots[slotName]
		: undefined
	if (!slot) {
		const loadError =
			policy.invalidSlots && Object.hasOwn(policy.invalidSlots, slotName)
				? policy.invalidSlots[slotName]
				: undefined
		if (loadError) {
			throw new SecretPlacementError(
				`Slot "${slotName}" of ${policy.packageName} is invalid in its published package.json, so the fetch gateway does not substitute it:\n${loadError}\nFix the slot and publish again.`,
				slotName,
			)
		}
		throw new SecretPlacementError(
			`"${slotName}" is not a kody.credentials slot of ${policy.packageName}. A package that declares kody.credentials substitutes only its declared slots. Declare "${slotName}" as a ${input.expectedKind} slot with the header it goes in.`,
			slotName,
		)
	}
	if (slot.kind !== input.expectedKind) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} has kind "${slot.kind}", but ${input.placeholder} needs a slot of kind "${input.expectedKind}".`,
			slotName,
		)
	}
	const placement = credentialSlotPlacement(slot)
	if (!placement) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} declares no placement, so the fetch gateway never substitutes it. Declare placement: { "header": "<name>" } on the slot.`,
			slotName,
		)
	}
	const template = placement.template ?? '{value}'
	if (placement.header.toLowerCase() !== headerName.toLowerCase()) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} may only be sent in its declared header "${placement.header}" (as "${template}"), not in "${headerName}".`,
			slotName,
		)
	}
	if (input.use === 'basic') {
		if (placement.template && placement.template !== basicAuthTemplate) {
			throw new SecretPlacementError(
				`Slot "${slotName}" of ${policy.packageName} declares template "${placement.template}", but a Basic Auth pair is sent as "${basicAuthTemplate}". Declare that template or no template on both slots.`,
				slotName,
			)
		}
		if (!isDerivedBasicAuthValue(input.headerValue, input.placeholder)) {
			throw new SecretPlacementError(
				`Header "${headerName}" must be exactly "Basic ${input.placeholder}" to send slots of ${policy.packageName} as Basic Auth.`,
				slotName,
			)
		}
		return
	}
	if (
		!headerValueMatchesTemplate(input.headerValue, template, input.placeholder)
	) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} must be sent as "${placement.header}: ${template}" with ${input.placeholder} in place of {value}. The "${headerName}" value does not match that template.`,
			slotName,
		)
	}
}

function assertDeclaredHeaderReferences(input: {
	policy: Extract<SecretPlacementPolicy, { kind: 'declared' }>
	headerName: string
	headerValue: string
	references: PlacedReference[]
}) {
	const { policy, headerName, headerValue, references } = input
	if (references.length > 1) {
		throw new SecretPlacementError(
			`Header "${headerName}" holds ${references.length} credential placeholders. A package that declares kody.credentials sends one slot per header.`,
			references[0] ? slotOf(references[0]) : null,
		)
	}
	const reference = references[0]
	if (!reference) return
	switch (reference.kind) {
		case 'secret':
		case 'integration-token':
			assertDeclaredSlotPlacement({
				policy,
				slotName: reference.name,
				expectedKind: reference.kind === 'secret' ? 'secret' : 'oauth',
				headerName,
				headerValue,
				placeholder: reference.placeholder,
				use: 'slot',
			})
			return
		case 'secret-basic':
			for (const slotName of [reference.usernameName, reference.passwordName]) {
				assertDeclaredSlotPlacement({
					policy,
					slotName,
					expectedKind: 'secret',
					headerName,
					headerValue,
					placeholder: reference.placeholder,
					use: 'basic',
				})
			}
			return
		case 'provider-secret':
			// A vault reference names no slot (the slot grammar has none), so the
			// header-only, HTTPS, and item-website rules are what apply.
			return
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
		}
	}
}

/**
 * Throws a {@link SecretPlacementError} naming the credential and the rule when
 * a placeholder would be substituted anywhere but an allowed header, or over
 * plain HTTP. `url` is the absolute request URL with placeholder delimiters
 * decoded. The body is not an input: it is never a substitution site.
 */
export async function assertSecretPlacement(input: {
	url: string
	headers: Headers
	/** Read only when a header holds a placeholder. */
	loadPolicy: () => Promise<SecretPlacementPolicy>
}) {
	const urlReference = referencesIn(decodePlaceholderPunctuation(input.url))[0]
	if (urlReference) throw refuseOutsideHeader(urlReference, 'URL')
	const headerReferences = Array.from(input.headers.entries()).flatMap(
		([headerName, headerValue]) => {
			const references = referencesIn(headerValue)
			return references.length > 0
				? [{ headerName, headerValue, references }]
				: []
		},
	)
	const firstHeaderReference = headerReferences[0]?.references[0]
	if (!firstHeaderReference) return
	if (new URL(input.url).protocol !== 'https:') {
		throw new SecretPlacementError(
			`${describeReference(firstHeaderReference)} cannot be sent over plain HTTP. The fetch gateway substitutes secrets only over HTTPS. Use an https:// URL.`,
			slotOf(firstHeaderReference),
		)
	}
	const policy = await input.loadPolicy()
	if (policy.kind === 'undeclared') return
	for (const entry of headerReferences) {
		assertDeclaredHeaderReferences({ policy, ...entry })
	}
}

/**
 * Throws a {@link SecretPlacementError} when the request body holds a
 * placeholder. The body is never a substitution site, so sending it would
 * put the literal reference upstream where the call then fails in a
 * confusing way. Only reads the bytes; an allowed body is sent unchanged.
 */
export function assertNoBodyPlaceholder(body: Uint8Array | null) {
	if (!body || body.byteLength === 0) return
	const text = decodePlaceholderPunctuation(new TextDecoder().decode(body))
	const reference = referencesIn(text)[0]
	if (!reference) return
	throw new SecretPlacementError(
		`${describeReference(reference)} is in the request body. ${bodyRuleHint} Send a credential in a header instead, for example headers: { Authorization: 'Bearer ${reference.placeholder}' }. A value that is not a credential (such as an account id) belongs in params or package storage, not a secret. To send the placeholder text itself (a message that quotes the syntax), set the request header x-kody-secret-resolution: headers-only.`,
	)
}
