/**
 * Where the fetch gateway may substitute a credential (credentials plan v4,
 * open call 15). Checked before any credential resolves:
 *
 * - every placeholder sits in a request header, never the URL, query, or body;
 * - the request is HTTPS;
 * - in a package that declares `kody.credentials`, each placeholder names a
 *   slot of the matching kind and sits in that slot's declared header, with the
 *   header value matching the slot's template.
 *
 * Host allowlists are checked separately, per credential, after resolution.
 */
import { McpCallerError } from '#mcp/caller-error.ts'
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
	parseBasicAuthSecretPlaceholdersFromFormUrlEncoded,
	parseIntegrationTokenPlaceholders,
	parseIntegrationTokenPlaceholdersFromFormUrlEncoded,
	parseProviderSecretPlaceholders,
	parseProviderSecretPlaceholdersFromFormUrlEncoded,
	parseSecretPlaceholders,
	parseSecretPlaceholdersFromFormUrlEncoded,
} from './placeholders.ts'

export class SecretPlacementError extends McpCallerError {
	constructor(message: string) {
		super(message)
		this.name = 'SecretPlacementError'
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
		)
	}
	const loaded = await loadPackageManifestBySourceId({
		env,
		baseUrl,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
	})
	const slots = loaded.manifest.kody.credentials
	return slots
		? { kind: 'declared', packageName: savedPackage.name, slots }
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

function referencesIn(value: string, formEncoded = false): PlacedReference[] {
	const secrets = formEncoded
		? parseSecretPlaceholdersFromFormUrlEncoded(value)
		: parseSecretPlaceholders(value)
	const basics = formEncoded
		? parseBasicAuthSecretPlaceholdersFromFormUrlEncoded(value)
		: parseBasicAuthSecretPlaceholders(value)
	const integrations = formEncoded
		? parseIntegrationTokenPlaceholdersFromFormUrlEncoded(value)
		: parseIntegrationTokenPlaceholders(value)
	const providers = formEncoded
		? parseProviderSecretPlaceholdersFromFormUrlEncoded(value)
		: parseProviderSecretPlaceholders(value)
	return [
		...secrets.map((secret) => ({
			kind: 'secret' as const,
			name: secret.name,
			placeholder: buildSecretPlaceholder(secret),
		})),
		...basics.map((basic) => ({
			kind: 'secret-basic' as const,
			usernameName: basic.username.name,
			passwordName: basic.password.name,
			placeholder: buildBasicAuthSecretPlaceholderFromReference(basic),
		})),
		...integrations.map((name) => ({
			kind: 'integration-token' as const,
			name,
			placeholder: buildIntegrationTokenPlaceholder(name),
		})),
		...providers.map((provider) => ({
			kind: 'provider-secret' as const,
			provider: provider.provider,
			placeholder: buildProviderSecretPlaceholder(provider),
		})),
	]
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
	const slot = policy.slots[slotName]
	if (!slot) {
		throw new SecretPlacementError(
			`"${slotName}" is not a kody.credentials slot of ${policy.packageName}. A package that declares kody.credentials substitutes only its declared slots. Declare "${slotName}" as a ${input.expectedKind} slot with the header it goes in.`,
		)
	}
	if (slot.kind !== input.expectedKind) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} has kind "${slot.kind}", but ${input.placeholder} needs a slot of kind "${input.expectedKind}".`,
		)
	}
	const placement = credentialSlotPlacement(slot)
	if (!placement) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} declares no placement, so the fetch gateway never substitutes it. Declare placement: { "header": "<name>" } on the slot.`,
		)
	}
	const template = placement.template ?? '{value}'
	if (placement.header.toLowerCase() !== headerName.toLowerCase()) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} may only be sent in its declared header "${placement.header}" (as "${template}"), not in "${headerName}".`,
		)
	}
	if (input.use === 'basic') {
		if (placement.template && placement.template !== basicAuthTemplate) {
			throw new SecretPlacementError(
				`Slot "${slotName}" of ${policy.packageName} declares template "${placement.template}", but a Basic Auth pair is sent as "${basicAuthTemplate}". Declare that template or no template on both slots.`,
			)
		}
		if (!isDerivedBasicAuthValue(input.headerValue, input.placeholder)) {
			throw new SecretPlacementError(
				`Header "${headerName}" must be exactly "Basic ${input.placeholder}" to send slots of ${policy.packageName} as Basic Auth.`,
			)
		}
		return
	}
	if (
		!headerValueMatchesTemplate(input.headerValue, template, input.placeholder)
	) {
		throw new SecretPlacementError(
			`Slot "${slotName}" of ${policy.packageName} must be sent as "${placement.header}: ${template}" with ${input.placeholder} in place of {value}. The "${headerName}" value does not match that template.`,
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
 * decoded; `body` is the text body the gateway would scan, if any.
 */
export async function assertSecretPlacement(input: {
	url: string
	headers: Headers
	body: { text: string; formEncoded: boolean } | null
	/** Read only when a header holds a placeholder. */
	loadPolicy: () => Promise<SecretPlacementPolicy>
}) {
	const urlReference = referencesIn(input.url)[0]
	if (urlReference) throw refuseOutsideHeader(urlReference, 'URL')
	if (input.body) {
		const bodyReference = referencesIn(
			input.body.text,
			input.body.formEncoded,
		)[0]
		if (bodyReference) throw refuseOutsideHeader(bodyReference, 'body')
	}
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
		)
	}
	const policy = await input.loadPolicy()
	if (policy.kind === 'undeclared') return
	for (const entry of headerReferences) {
		assertDeclaredHeaderReferences({ policy, ...entry })
	}
}
