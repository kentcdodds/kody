import {
	buildAccountSecretId,
	parseAccountSecretId,
	parseAccountSecretPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { type AccountSecretsLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	listPackageSecretsByPackageIds,
	listSecrets,
	resolveSecret,
} from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type AccountEditableSecretScope = Extract<SecretScope, 'package' | 'user'>

type SavedPackageOption = {
	id: string
	title: string
	updatedAt: string
}

type SavedPackageSummary = {
	id: string
	kodyId: string
	name: string
	updatedAt: string
}

type AccountSecretListItem = {
	id: string
	name: string
	scope: AccountEditableSecretScope
	description: string
	packageId: string | null
	packageTitle: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

type AccountSecretDetail = AccountSecretListItem & {
	value: string
}

type SecretApprovalView = {
	name: string
	scope: SecretScope
	requestedHost: string
	requestedCapability: string | null
	requestedPackageId: string | null
	currentAllowedHosts: Array<string>
	currentAllowedPackages: Array<string>
}

const secretsBasePath = '/account/secrets'

export function readAccountSecretsSelectedSecretId(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	const fromPath = readSelectedSecretIdFromPath(url.pathname)
	if (fromPath) return fromPath
	const fromQuery = url.searchParams.get('selected')
	return fromQuery?.trim() ? fromQuery.trim() : null
}

function readSelectedSecretIdFromPath(pathname: string) {
	if (pathname === `${secretsBasePath}/new`) return null
	if (pathname === `${secretsBasePath}/approve`) return null
	const parsedPath = parseAccountSecretPath(pathname)
	if (parsedPath) return parsedPath.id
	return null
}

export async function loadAccountSecretsData(input: {
	request: Request
	env: Env
	user: AuthenticatedUser
	selectedSecretId?: string | null
	packageOptions?: Array<SavedPackageOption>
	savedPackages?: Array<SavedPackageSummary>
}): Promise<AccountSecretsLoaderData> {
	const selectedSecretId =
		input.selectedSecretId === undefined
			? readAccountSecretsSelectedSecretId(input.request.url)
			: input.selectedSecretId
	return buildAccountSecretsPayload({
		...input,
		selectedSecretId,
	})
}

async function buildAccountSecretsPayload(input: {
	request: Request
	env: Env
	user: AuthenticatedUser
	selectedSecretId?: string | null
	packageOptions?: Array<SavedPackageOption>
	savedPackages?: Array<SavedPackageSummary>
}): Promise<AccountSecretsLoaderData> {
	const url = new URL(input.request.url)
	const requestedApprovalHost = readApprovalHost(url)
	const requestedCapability = readRequestedCapability(url)
	const requestedPackageId = readRequestedPackageId(url)
	const savedPackages =
		input.savedPackages ??
		(await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.user.mcpUser.userId,
		}))
	const packageOptions = input.packageOptions ?? toPackageOptions(savedPackages)
	const packageLookup = toAllowedPackageLookup(savedPackages)
	const secrets = await listAccountSecrets({
		env: input.env,
		user: input.user,
		packageOptions,
	})
	const selectedSecret = input.selectedSecretId
		? await resolveAccountSecretDetail({
				env: input.env,
				userId: input.user.mcpUser.userId,
				secretId: input.selectedSecretId,
				secrets,
			})
		: null

	let approval: SecretApprovalView | null = null
	let approvalError: string | null = null
	if (input.selectedSecretId && (requestedApprovalHost || requestedPackageId)) {
		try {
			approval = await resolveSecretApprovalView({
				env: input.env,
				userId: input.user.mcpUser.userId,
				secretId: input.selectedSecretId,
				requestedHost: requestedApprovalHost,
				requestedCapability,
				requestedPackageId,
			})
		} catch (error) {
			approvalError =
				error instanceof Error
					? error.message
					: 'Unable to read approval request.'
		}
	}

	return {
		ok: true,
		email: input.user.email,
		packageOptions,
		packages: Array.from(packageLookup.values()).map((packageEntry) => ({
			id: packageEntry.packageId,
			kodyId: packageEntry.kodyId,
			name: packageEntry.name,
		})),
		secrets,
		selectedSecret,
		approval,
		approvalError,
	}
}

async function listAccountSecrets(input: {
	env: Env
	user: AuthenticatedUser
	packageOptions: Array<SavedPackageOption>
}) {
	const packageTitles = new Map(
		input.packageOptions.map((packageOption) => [
			packageOption.id,
			packageOption.title,
		]),
	)
	const [userSecrets, packageSecrets] = await Promise.all([
		listSecrets({
			env: input.env,
			userId: input.user.mcpUser.userId,
			scope: 'user',
		}),
		listPackageSecretsByPackageIds({
			env: input.env,
			userId: input.user.mcpUser.userId,
			packageIds: input.packageOptions.map((packageOption) => packageOption.id),
		}),
	])

	return [
		...userSecrets.map((secret) =>
			toAccountSecretListItem(secret, packageTitles),
		),
		...Array.from(packageSecrets.values())
			.flat()
			.map((secret) => toAccountSecretListItem(secret, packageTitles)),
	].sort((left, right) => {
		return (
			left.name.localeCompare(right.name) ||
			left.scope.localeCompare(right.scope) ||
			(left.packageTitle ?? '').localeCompare(right.packageTitle ?? '')
		)
	})
}

type ResolvedSecretApproval =
	| {
			kind: 'host'
			name: string
			scope: SecretScope
			requestedHost: string
			storageContext: StorageContext | null
	  }
	| {
			kind: 'package'
			name: string
			scope: SecretScope
			packageId: string
			storageContext: StorageContext | null
	  }

function resolveApprovalRequest(input: {
	secretId: string | null
	requestedHost: string | null
	requestedPackageId: string | null
}): ResolvedSecretApproval {
	const parsed = input.secretId ? parseAccountSecretId(input.secretId) : null
	if (!parsed) {
		throw new Error('Invalid approval request.')
	}
	if (input.requestedHost && input.requestedPackageId) {
		throw new Error('Approval request contains both host and package.')
	}
	const storageContext = getSecretContextForAccountSecret(parsed)
	if (input.requestedPackageId) {
		if (parsed.scope !== 'user') {
			throw new Error('Only user secrets support package approvals.')
		}
		return {
			kind: 'package',
			name: parsed.name,
			scope: parsed.scope,
			packageId: input.requestedPackageId,
			storageContext,
		}
	}
	if (input.requestedHost) {
		const [requestedHost] = normalizeAllowedHosts([input.requestedHost])
		if (!requestedHost) {
			throw new Error('Invalid approval request host.')
		}
		return {
			kind: 'host',
			name: parsed.name,
			scope: parsed.scope,
			requestedHost,
			storageContext,
		}
	}
	throw new Error('Approval request is missing a host or package.')
}

async function resolveSecretApprovalView(input: {
	env: Env
	userId: string
	secretId: string
	requestedHost: string | null
	requestedCapability: string | null
	requestedPackageId: string | null
}) {
	const approval = resolveApprovalRequest(input)
	const secrets = await listSecrets({
		env: input.env,
		userId: input.userId,
		scope: approval.scope,
		storageContext: approval.storageContext,
	})
	const secret = secrets.find(
		(item) => item.name === approval.name && item.scope === approval.scope,
	)
	if (!secret) {
		throw new Error('Secret not found.')
	}
	return {
		name: approval.name,
		scope: approval.scope,
		requestedHost: approval.kind === 'host' ? approval.requestedHost : '',
		requestedCapability: input.requestedCapability,
		requestedPackageId: approval.kind === 'package' ? approval.packageId : null,
		currentAllowedHosts: secret.allowedHosts,
		currentAllowedPackages: secret.allowedPackages,
	} satisfies SecretApprovalView
}

async function resolveAccountSecretDetail(input: {
	env: Env
	userId: string
	secretId: string
	secrets: Array<AccountSecretListItem>
}) {
	const parsed = parseAccountSecretId(input.secretId)
	if (!parsed) return null

	const selected = input.secrets.find((secret) => secret.id === input.secretId)
	if (!selected) return null
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: parsed.name,
		scope: parsed.scope,
		storageContext: getSecretContextForAccountSecret(parsed),
	})
	return {
		...selected,
		value: resolved.found && resolved.value != null ? resolved.value : '',
	} satisfies AccountSecretDetail
}

function toAccountSecretListItem(
	secret: {
		name: string
		scope: SecretScope
		description: string
		packageId: string | null
		allowedHosts: Array<string>
		allowedCapabilities: Array<string>
		allowedPackages: Array<string>
		createdAt: string
		updatedAt: string
		ttlMs: number | null
	},
	packageTitles: Map<string, string>,
) {
	if (secret.scope === 'session') {
		throw new Error('Session secrets are not editable from the account page.')
	}
	const scope = secret.scope === 'package' ? 'package' : 'user'

	return {
		id: buildAccountSecretId({
			name: secret.name,
			scope,
			packageId: secret.packageId,
		}),
		name: secret.name,
		scope,
		description: secret.description,
		packageId: secret.packageId,
		packageTitle: secret.packageId
			? (packageTitles.get(secret.packageId) ?? null)
			: null,
		allowedHosts: secret.allowedHosts,
		allowedCapabilities: secret.allowedCapabilities,
		allowedPackages: secret.allowedPackages,
		createdAt: secret.createdAt,
		updatedAt: secret.updatedAt,
		ttlMs: secret.ttlMs,
	} satisfies AccountSecretListItem
}

function toPackageOptions(
	savedPackages: Array<{
		id: string
		name: string
		updatedAt: string
	}>,
) {
	return savedPackages
		.map((savedPackage) => ({
			id: savedPackage.id,
			title: savedPackage.name,
			updatedAt: savedPackage.updatedAt,
		}))
		.sort((left, right) => {
			return (
				right.updatedAt.localeCompare(left.updatedAt) ||
				left.title.localeCompare(right.title)
			)
		})
}

function toAllowedPackageLookup(
	savedPackages: Array<{
		id: string
		kodyId: string
		name: string
	}>,
) {
	return new Map(
		savedPackages.map((savedPackage) => [
			savedPackage.id,
			{
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
			},
		]),
	)
}

export function getSecretContextForAccountSecret(input: {
	scope: SecretScope
	packageId: string | null
	sessionId?: string | null
}): StorageContext {
	return {
		sessionId: input.scope === 'session' ? (input.sessionId ?? null) : null,
		appId: null,
		packageId: input.scope === 'package' ? input.packageId : null,
	}
}

function readApprovalHost(url: URL) {
	const value = url.searchParams.get('allowed-host')
	return value?.trim() ? value.trim() : null
}

function readRequestedPackageId(url: URL) {
	const value = url.searchParams.get('package_id')
	return value?.trim() ? value.trim() : null
}

function readRequestedCapability(url: URL) {
	const value = url.searchParams.get('capability')
	return value?.trim() ? value.trim() : null
}

export { resolveApprovalRequest, toPackageOptions, listAccountSecrets }

export { buildAccountSecretsPayload }
