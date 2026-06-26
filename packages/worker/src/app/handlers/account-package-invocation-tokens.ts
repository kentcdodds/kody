import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import {
	deletePackageInvocationToken,
	hashPackageInvocationBearerToken,
	insertPackageInvocationToken,
	listPackageInvocationTokensByUserId,
	revokePackageInvocationToken,
	type PackageInvocationTokenRecord,
	unrevokePackageInvocationToken,
	updatePackageInvocationToken,
} from '#worker/package-invocations/repo.ts'
import {
	normalizeExportName,
	packageInvocationScopeWildcard,
} from '#worker/package-invocations/service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type SavedPackageSummary = {
	id: string
	kodyId: string
	name: string
}

type AccountPackageInvocationTokenListItem = {
	id: string
	name: string
	packageIds: Array<string>
	packageKodyIds: Array<string>
	exportNames: Array<string>
	sources: Array<string>
	createdAt: string
	updatedAt: string
	lastUsedAt: string | null
	revokedAt: string | null
}

type AccountPackageInvocationTokensPayload = {
	ok: true
	email: string
	username: string
	invocationUrlOrigin: string
	packages: Array<SavedPackageSummary>
	tokens: Array<AccountPackageInvocationTokenListItem>
	selectedTokenId?: string
}

export function createAccountPackageInvocationTokensHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const response = render(Layout({ title: 'Package invocation tokens' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies Action<typeof routes.accountPackageInvocationTokens>
}

export function createAccountPackageInvocationTokensApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await buildPayload({ env, request, user }))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readString(body, 'action')
			if (action === 'create') {
				return handleCreateAction({ env, request, user, body })
			}
			if (action === 'revoke') {
				return handleRevokeAction({ env, request, user, body })
			}
			if (action === 'unrevoke') {
				return handleUnrevokeAction({ env, request, user, body })
			}
			if (action === 'delete') {
				return handleDeleteAction({ env, request, user, body })
			}
			if (action === 'update') {
				return handleUpdateAction({ env, request, user, body })
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountPackageInvocationTokensApi>
}

async function handleCreateAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const name = readString(input.body, 'name')
	const rawToken = readString(input.body, 'rawToken')
	if (!name) {
		return jsonResponse({ ok: false, error: 'Token name is required.' }, 400)
	}
	if (!rawToken) {
		return jsonResponse({ ok: false, error: 'Raw token is required.' }, 400)
	}

	let packageIds: Array<string>
	let packageKodyIds: Array<string>
	let exportNames: Array<string>
	try {
		packageIds = normalizeScopeList(
			readStringArray(input.body, ['packageIds', 'packageId', 'package_ids']),
			{ allowWildcard: true },
		)
		packageKodyIds = normalizeScopeList(
			readStringArray(input.body, [
				'packageKodyIds',
				'packageKodyId',
				'package_kody_ids',
				'kodyIds',
				'kodyId',
			]),
			{ allowWildcard: true },
		)
		exportNames = normalizeExportScopeList(
			readStringArray(input.body, [
				'exportNames',
				'exportName',
				'export_names',
			]),
		)
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Invalid package invocation token scope.',
			},
			400,
		)
	}
	const sources = normalizeScopeList(
		readStringArray(input.body, ['sources', 'source', 'source_names']),
		{ allowWildcard: false },
	)

	if (packageIds.length === 0 && packageKodyIds.length === 0) {
		return jsonResponse(
			{ ok: false, error: 'Choose at least one package scope.' },
			400,
		)
	}
	if (exportNames.length === 0) {
		return jsonResponse(
			{ ok: false, error: 'Choose at least one export scope.' },
			400,
		)
	}

	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.user.mcpUser.userId,
	})
	const scopeError = validatePackageScopes({
		savedPackages,
		packageIds,
		packageKodyIds,
	})
	if (scopeError) {
		return jsonResponse({ ok: false, error: scopeError }, 400)
	}

	const tokenId = crypto.randomUUID()
	const tokenHash = await hashPackageInvocationBearerToken(rawToken)
	try {
		await insertPackageInvocationToken({
			db: input.env.APP_DB,
			row: {
				id: tokenId,
				userId: input.user.mcpUser.userId,
				name,
				tokenHash,
				email: input.user.mcpUser.email,
				displayName: input.user.mcpUser.displayName,
				packageIds,
				packageKodyIds,
				exportNames,
				sources,
			},
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : ''
		if (message.includes('UNIQUE') || message.includes('token_hash')) {
			return jsonResponse(
				{
					ok: false,
					error:
						'A package invocation token with that raw value already exists.',
				},
				409,
			)
		}
		throw error
	}

	return jsonResponse({
		...(await buildPayload({
			env: input.env,
			request: input.request,
			user: input.user,
			savedPackages,
		})),
		selectedTokenId: tokenId,
	})
}

async function handleUpdateAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const id = readString(input.body, 'id')
	const name = readString(input.body, 'name')
	const rawToken = readString(input.body, 'rawToken')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	if (!name) {
		return jsonResponse({ ok: false, error: 'Token name is required.' }, 400)
	}

	let packageIds: Array<string>
	let packageKodyIds: Array<string>
	let exportNames: Array<string>
	try {
		packageIds = normalizeScopeList(
			readStringArray(input.body, ['packageIds', 'packageId', 'package_ids']),
			{ allowWildcard: true },
		)
		packageKodyIds = normalizeScopeList(
			readStringArray(input.body, [
				'packageKodyIds',
				'packageKodyId',
				'package_kody_ids',
				'kodyIds',
				'kodyId',
			]),
			{ allowWildcard: true },
		)
		exportNames = normalizeExportScopeList(
			readStringArray(input.body, [
				'exportNames',
				'exportName',
				'export_names',
			]),
		)
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Invalid package invocation token scope.',
			},
			400,
		)
	}
	const sources = normalizeScopeList(
		readStringArray(input.body, ['sources', 'source', 'source_names']),
		{ allowWildcard: false },
	)

	if (packageIds.length === 0 && packageKodyIds.length === 0) {
		return jsonResponse(
			{ ok: false, error: 'Choose at least one package scope.' },
			400,
		)
	}
	if (exportNames.length === 0) {
		return jsonResponse(
			{ ok: false, error: 'Choose at least one export scope.' },
			400,
		)
	}

	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.user.mcpUser.userId,
	})
	const scopeError = validatePackageScopes({
		savedPackages,
		packageIds,
		packageKodyIds,
	})
	if (scopeError) {
		return jsonResponse({ ok: false, error: scopeError }, 400)
	}

	const tokenHash = rawToken
		? await hashPackageInvocationBearerToken(rawToken)
		: undefined
	let updated: boolean
	try {
		updated = await updatePackageInvocationToken({
			db: input.env.APP_DB,
			userId: input.user.mcpUser.userId,
			id,
			name,
			tokenHash,
			packageIds,
			packageKodyIds,
			exportNames,
			sources,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : ''
		if (message.includes('UNIQUE') || message.includes('token_hash')) {
			return jsonResponse(
				{
					ok: false,
					error:
						'A package invocation token with that raw value already exists.',
				},
				409,
			)
		}
		throw error
	}
	if (!updated) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found or revoked.' },
			404,
		)
	}

	return jsonResponse({
		...(await buildPayload({
			env: input.env,
			request: input.request,
			user: input.user,
			savedPackages,
		})),
		selectedTokenId: id,
	})
}

async function handleRevokeAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const id = readString(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const revoked = await revokePackageInvocationToken({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		id,
	})
	if (!revoked) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found.' },
			404,
		)
	}
	return jsonResponse(
		await buildPayload({
			env: input.env,
			request: input.request,
			user: input.user,
		}),
	)
}

async function handleUnrevokeAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const id = readString(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const restored = await unrevokePackageInvocationToken({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		id,
	})
	if (!restored) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found or active.' },
			404,
		)
	}
	return jsonResponse({
		...(await buildPayload({
			env: input.env,
			request: input.request,
			user: input.user,
		})),
		selectedTokenId: id,
	})
}

async function handleDeleteAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const id = readString(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const deleted = await deletePackageInvocationToken({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		id,
	})
	if (!deleted) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found.' },
			404,
		)
	}
	return jsonResponse(
		await buildPayload({
			env: input.env,
			request: input.request,
			user: input.user,
		}),
	)
}

async function buildPayload(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	savedPackages?: Array<SavedPackageSummary>
}): Promise<AccountPackageInvocationTokensPayload> {
	const userId = input.user.mcpUser.userId
	const [savedPackages, tokens] = await Promise.all([
		input.savedPackages ??
			listSavedPackagesByUserId(input.env.APP_DB, { userId }),
		listPackageInvocationTokensByUserId({
			db: input.env.APP_DB,
			userId,
		}),
	])
	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		invocationUrlOrigin: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		packages: savedPackages.map((savedPackage) => ({
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
		})),
		tokens: tokens.map(toListItem),
	}
}

function toListItem(
	token: PackageInvocationTokenRecord,
): AccountPackageInvocationTokenListItem {
	return {
		id: token.id,
		name: token.name,
		packageIds: token.packageIds,
		packageKodyIds: token.packageKodyIds,
		exportNames: token.exportNames,
		sources: token.sources,
		createdAt: token.created_at,
		updatedAt: token.updated_at,
		lastUsedAt: token.last_used_at,
		revokedAt: token.revoked_at,
	}
}

function validatePackageScopes(input: {
	savedPackages: Array<SavedPackageSummary>
	packageIds: Array<string>
	packageKodyIds: Array<string>
}) {
	const ownedPackageIds = new Set(
		input.savedPackages.map((savedPackage) => savedPackage.id),
	)
	const ownedKodyIds = new Set(
		input.savedPackages.map((savedPackage) => savedPackage.kodyId),
	)
	const invalidPackageIds = input.packageIds.filter(
		(packageId) =>
			packageId !== packageInvocationScopeWildcard &&
			!ownedPackageIds.has(packageId),
	)
	if (invalidPackageIds.length > 0) {
		return `Unknown package id: ${invalidPackageIds[0]}`
	}
	const invalidKodyIds = input.packageKodyIds.filter(
		(kodyId) =>
			kodyId !== packageInvocationScopeWildcard && !ownedKodyIds.has(kodyId),
	)
	if (invalidKodyIds.length > 0) {
		return `Unknown package Kody id: ${invalidKodyIds[0]}`
	}
	return null
}

function normalizeScopeList(
	values: Array<string>,
	options: { allowWildcard: boolean },
) {
	const normalized = values
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
	if (
		options.allowWildcard &&
		normalized.includes(packageInvocationScopeWildcard)
	) {
		return [packageInvocationScopeWildcard]
	}
	return Array.from(new Set(normalized))
}

function normalizeExportScopeList(values: Array<string>) {
	const normalized = values
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.map((value) =>
			value === packageInvocationScopeWildcard
				? packageInvocationScopeWildcard
				: normalizeExportName(value),
		)
	if (normalized.includes(packageInvocationScopeWildcard)) {
		return [packageInvocationScopeWildcard]
	}
	return Array.from(new Set(normalized))
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : ''
}

function readStringArray(body: object, keys: Array<string>) {
	const out: Array<string> = []
	const record = body as Record<string, unknown>
	for (const key of keys) {
		const value = record[key]
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === 'string') out.push(...splitStringList(entry))
			}
		} else if (typeof value === 'string') {
			out.push(...splitStringList(value))
		}
	}
	return out
}

function splitStringList(value: string) {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
