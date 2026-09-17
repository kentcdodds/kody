import { McpCallerError } from '#mcp/caller-error.ts'

export const secretProviderResolveTimeoutMs = 8_000
export const secretProviderCanonicalizeTimeoutMs = 5_000
export const secretProviderCacheTtlMs = 30_000

export class SecretProviderError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'SecretProviderError'
	}
}

export function createMissingProviderBindingMessage(providerId: string) {
	return `No secret provider is bound for "${providerId}". Bind a saved package that declares kody.secretProvider.id "${providerId}" on /account/secret-providers, then retry.`
}

export function createMissingProviderDoorSecretMessage(input: {
	providerId: string
	doorSecretName: string
}) {
	return `The "${input.providerId}" service account secret "${input.doorSecretName}" is missing or expired. Reconnect the service account on /account/secret-providers, then retry.`
}

export function createProviderPackageMismatchMessage(input: {
	providerId: string
	packageName: string
}) {
	return `Bound package "${input.packageName}" no longer declares kody.secretProvider.id "${input.providerId}". Bind a package that still declares that provider id.`
}

export function createBrokenProviderRefMessage(providerId: string) {
	return `Secret provider "${providerId}" received a broken ref. Use {{secret/${providerId}:i/<item-id>/<field>}} (UUID or 1Password Connect 26-char id) or ask the provider package to canonicalize the synonym.`
}

export function createProviderNoWebsitesMessage(providerId: string) {
	return `Secret provider "${providerId}" refused this item because it has no usable websites. Add a website on the item, then retry.`
}

export function createProviderHostDeniedMessage(input: {
	providerId: string
	host: string
}) {
	return `Secret provider "${input.providerId}" is not allowed for host "${input.host}". The item's websites do not include that hostname.`
}

export function createProviderPackageNotGrantedMessage(input: {
	providerId: string
	canonicalRef: string
	packageName: string
	approvalUrl: string
}) {
	return `Package "${input.packageName}" is not granted to use {{secret/${input.providerId}:${input.canonicalRef}}}. Ask the account owner to approve that grant, then retry. Approval link: ${input.approvalUrl}`
}

export function createProviderErrorMessage(providerId: string) {
	return `Secret provider "${providerId}" failed to resolve this ref. Check the bound package and service account, then retry.`
}

export function createSealedSecretProviderExportDeniedMessage() {
	return 'Sealed secret-provider exports can only run at the fetch boundary. Ordinary execute, packages.invoke, and kody:@ imports cannot call them or observe resolved values.'
}

export function createSecretProviderGrantRequiresWebsiteMessage(input: {
	approvalUrl: string
}) {
	return `Agents cannot grant a provider ref to a saved package. Only the account owner can add that grant on the website. Send the user this approval link and wait: ${input.approvalUrl}`
}

export function createSecretProviderGrantAlreadyPresentMessage(input: {
	packageName: string
}) {
	return `Package "${input.packageName}" already has a grant for this provider ref.`
}
