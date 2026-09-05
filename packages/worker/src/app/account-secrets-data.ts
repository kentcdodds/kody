import {
	buildAccountSecretId,
	parseAccountSecretId,
	parseAccountSecretPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	listPackageSecretsByPackageIds,
	listSecrets,
	resolveSecret,
} from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { normalizeBulkHostApprovalHosts } from '#mcp/secrets/host-approval.ts'
import { normalizeBulkPackageSecretApprovalNames } from '#mcp/secrets/package-approval-url.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

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
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
	ttlMs: number | null
}

type AccountSecretDetail = AccountSecretListItem & {
	value: string
}

type SecretApprovalView = {
	name: string
	names: Array<string>
	scope: SecretScope
	requestedHost: string
	requestedHosts: Array<string>
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
	const requestedApprovalHosts = readApprovalHosts(url)
	const requestedPackageId = readRequestedPackageId(url)
	const requestedSecretNames = readRequestedSecretNames(url)
	const requestedHostScope = readHostApprovalScope(url)
	const requestedHostStorageContext = getHostApprovalStorageContext(url)
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
	const hasApprovalTarget = Boolean(
		requestedApprovalHosts.length > 0 || requestedPackageId,
	)
	const hasApprovalSubject = Boolean(
		input.selectedSecretId || requestedSecretNames.length > 0,
	)
	if (hasApprovalSubject && hasApprovalTarget) {
		try {
			approval = await resolveSecretApprovalView({
				env: input.env,
				userId: input.user.mcpUser.userId,
				secretId: input.selectedSecretId ?? null,
				requestedHosts: requestedApprovalHosts,
				requestedPackageId,
				requestedSecretNames,
				requestedHostScope,
				requestedHostStorageContext,
				savedPackageIds: new Set(savedPackages.map((entry) => entry.id)),
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
			kind: 'host_bulk'
			names: Array<string>
			hosts: Array<string>
			scope: SecretScope
			storageContext: StorageContext | null
	  }
	| {
			kind: 'package'
			name: string
			scope: SecretScope
			packageId: string
			storageContext: StorageContext | null
	  }
	| {
			kind: 'package_bulk'
			names: Array<string>
			scope: 'user'
			packageId: string
			storageContext: StorageContext | null
	  }

function resolveApprovalRequest(input: {
	secretId: string | null
	requestedHosts: Array<string>
	requestedPackageId: string | null
	requestedSecretNames?: Array<string>
	requestedHostScope?: SecretScope
	requestedHostStorageContext?: StorageContext | null
}): ResolvedSecretApproval {
	const requestedSecretNames = normalizeBulkPackageSecretApprovalNames(
		input.requestedSecretNames ?? [],
	)
	const requestedHosts = normalizeBulkHostApprovalHosts(input.requestedHosts)
	if (requestedHosts.length > 0 && input.requestedPackageId) {
		throw new Error('Approval request contains both host and package.')
	}
	if (requestedSecretNames.length > 0) {
		if (input.secretId) {
			throw new Error(
				'Approval request cannot combine selected secret and names list.',
			)
		}
		if (input.requestedPackageId) {
			return {
				kind: 'package_bulk',
				names: requestedSecretNames,
				scope: 'user',
				packageId: input.requestedPackageId,
				storageContext: null,
			}
		}
		if (requestedHosts.length === 0) {
			throw new Error('Bulk secret approval requires a package_id or hosts.')
		}
		return {
			kind: 'host_bulk',
			names: requestedSecretNames,
			hosts: requestedHosts,
			scope: input.requestedHostScope ?? 'user',
			storageContext: input.requestedHostStorageContext ?? null,
		}
	}
	const parsed = input.secretId ? parseAccountSecretId(input.secretId) : null
	if (!parsed) {
		throw new Error('Invalid approval request.')
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
	if (requestedHosts.length === 1) {
		const requestedHost = requestedHosts[0]
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
	if (requestedHosts.length > 1) {
		return {
			kind: 'host_bulk',
			names: [parsed.name],
			hosts: requestedHosts,
			scope: parsed.scope,
			storageContext,
		}
	}
	throw new Error('Approval request is missing a host or package.')
}

async function resolveSecretApprovalView(input: {
	env: Env
	userId: string
	secretId: string | null
	requestedHosts: Array<string>
	requestedPackageId: string | null
	requestedSecretNames: Array<string>
	requestedHostScope: SecretScope
	requestedHostStorageContext: StorageContext | null
	savedPackageIds: Set<string>
}) {
	const approval = resolveApprovalRequest({
		secretId: input.secretId,
		requestedHosts: input.requestedHosts,
		requestedPackageId: input.requestedPackageId,
		requestedSecretNames: input.requestedSecretNames,
		requestedHostScope: input.requestedHostScope,
		requestedHostStorageContext: input.requestedHostStorageContext,
	})
	if (approval.kind === 'package_bulk') {
		if (!input.savedPackageIds.has(approval.packageId)) {
			throw new Error('Package not found for approval.')
		}
		const secrets = await listSecrets({
			env: input.env,
			userId: input.userId,
			scope: 'user',
			includeIntegrationOwned: true,
		})
		const byName = new Map(
			secrets
				.filter((secret) => secret.scope === 'user')
				.map((secret) => [secret.name, secret]),
		)
		const foundNames: Array<string> = []
		const pendingNames: Array<string> = []
		for (const name of approval.names) {
			const secret = byName.get(name)
			if (!secret) continue
			foundNames.push(name)
			if (!secret.allowedPackages.includes(approval.packageId)) {
				pendingNames.push(name)
			}
		}
		if (foundNames.length === 0) {
			throw new Error('None of the listed secrets were found.')
		}
		if (pendingNames.length === 0) {
			return {
				name: foundNames[0] ?? '',
				names: foundNames,
				scope: 'user',
				requestedHost: '',
				requestedHosts: [],
				requestedPackageId: approval.packageId,
				currentAllowedHosts: [],
				currentAllowedPackages: [approval.packageId],
			} satisfies SecretApprovalView
		}
		const firstPending = pendingNames[0]
		const firstSecret = firstPending ? byName.get(firstPending) : null
		return {
			name: firstPending ?? '',
			names: pendingNames,
			scope: 'user',
			requestedHost: '',
			requestedHosts: [],
			requestedPackageId: approval.packageId,
			currentAllowedHosts: firstSecret?.allowedHosts ?? [],
			currentAllowedPackages: firstSecret?.allowedPackages ?? [],
		} satisfies SecretApprovalView
	}
	if (approval.kind === 'host_bulk') {
		const secrets = await listSecrets({
			env: input.env,
			userId: input.userId,
			scope: approval.scope,
			storageContext: approval.storageContext,
			includeIntegrationOwned: true,
		})
		const byName = new Map(
			secrets
				.filter((secret) => secret.scope === approval.scope)
				.map((secret) => [secret.name, secret]),
		)
		const foundNames: Array<string> = []
		for (const name of approval.names) {
			if (byName.has(name)) foundNames.push(name)
		}
		if (foundNames.length === 0) {
			throw new Error('None of the listed secrets were found.')
		}
		const firstSecret = byName.get(foundNames[0] ?? '')
		return {
			name: foundNames[0] ?? '',
			names: foundNames,
			scope: approval.scope,
			requestedHost: approval.hosts[0] ?? '',
			requestedHosts: approval.hosts,
			requestedPackageId: null,
			currentAllowedHosts: firstSecret?.allowedHosts ?? [],
			currentAllowedPackages: firstSecret?.allowedPackages ?? [],
		} satisfies SecretApprovalView
	}
	const secrets = await listSecrets({
		env: input.env,
		userId: input.userId,
		scope: approval.scope,
		storageContext: approval.storageContext,
		includeIntegrationOwned: true,
	})
	const secret = secrets.find(
		(item) => item.name === approval.name && item.scope === approval.scope,
	)
	if (!secret) {
		throw new Error('Secret not found.')
	}
	if (
		approval.kind === 'package' &&
		!input.savedPackageIds.has(approval.packageId)
	) {
		throw new Error('Package not found for approval.')
	}
	return {
		name: approval.name,
		names: [approval.name],
		scope: approval.scope,
		requestedHost: approval.kind === 'host' ? approval.requestedHost : '',
		requestedHosts: approval.kind === 'host' ? [approval.requestedHost] : [],
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
		includeExpired: true,
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
		allowedPackages: Array<string>
		createdAt: string
		updatedAt: string
		expiresAt: string | null
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
		allowedPackages: secret.allowedPackages,
		createdAt: secret.createdAt,
		updatedAt: secret.updatedAt,
		expiresAt: secret.expiresAt,
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

function readApprovalHosts(url: URL) {
	const values = [
		...url.searchParams.getAll('hosts'),
		...url.searchParams.getAll('host'),
		...url.searchParams.getAll('allowed-host'),
		...url.searchParams.getAll('allowedHosts'),
	]
	return normalizeBulkHostApprovalHosts(
		values.flatMap((value) => value.split(',')),
	)
}

function readHostApprovalScope(url: URL): SecretScope {
	const value = url.searchParams.get('scope')?.trim()
	switch (value) {
		case 'package':
		case 'session':
		case 'user':
			return value
		default:
			return 'user'
	}
}

function getHostApprovalStorageContext(url: URL): StorageContext | null {
	const scope = readHostApprovalScope(url)
	switch (scope) {
		case 'package': {
			const packageId = url.searchParams.get('packageId')?.trim()
			if (!packageId) return null
			return { sessionId: null, appId: null, packageId }
		}
		case 'session': {
			const sessionId = url.searchParams.get('sessionId')?.trim()
			if (!sessionId) return null
			return { sessionId, appId: null, packageId: null }
		}
		case 'user':
			return null
		default: {
			const _exhaustive: never = scope
			return _exhaustive
		}
	}
}

function readRequestedPackageId(url: URL) {
	const value = url.searchParams.get('package_id')
	return value?.trim() ? value.trim() : null
}

function readRequestedSecretNames(url: URL) {
	const values = [
		...url.searchParams.getAll('names'),
		...url.searchParams.getAll('name'),
	]
	return normalizeBulkPackageSecretApprovalNames(
		values.flatMap((value) => value.split(',')),
	)
}

export {
	getHostApprovalStorageContext,
	listAccountSecrets,
	readApprovalHosts,
	readHostApprovalScope,
	resolveApprovalRequest,
	toPackageOptions,
}

export { buildAccountSecretsPayload }
