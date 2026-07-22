import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountPackageInvocationTokensData } from '#app/account-package-invocation-tokens-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import {
	deletePackageInvocationToken,
	hashPackageInvocationBearerToken,
	insertPackageInvocationToken,
	reinstatePackageInvocationToken,
	revokePackageInvocationToken,
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

export function createAccountPackageInvocationTokensHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountPackageInvocationTokens =
				await loadAccountPackageInvocationTokensData({
					env,
					request,
					user,
					pathTokenId:
						typeof params === 'object' &&
						params !== null &&
						'tokenId' in params &&
						typeof params.tokenId === 'string'
							? params.tokenId
							: undefined,
				})
			return renderAppPage({
				request,
				env,
				title: 'Package invocation tokens',
				loaderData: { accountPackageInvocationTokens },
			})
		},
	} satisfies Action<
		| typeof routes.accountPackageInvocationTokens
		| typeof routes.accountPackageInvocationTokenNew
		| typeof routes.accountPackageInvocationTokenDetail
	>
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
				return jsonResponse(
					await loadAccountPackageInvocationTokensData({ env, request, user }),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readTrimmedStringOrEmpty(body, 'action')
			if (action === 'create') {
				return handleCreateAction({ env, request, user, body })
			}
			if (action === 'revoke') {
				return handleRevokeAction({ env, request, user, body })
			}
			if (action === 'reinstate') {
				return handleReinstateAction({ env, request, user, body })
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
	const name = readTrimmedStringOrEmpty(input.body, 'name')
	const rawToken = readTrimmedStringOrEmpty(input.body, 'rawToken')
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
		...(await loadAccountPackageInvocationTokensData({
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
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	const name = readTrimmedStringOrEmpty(input.body, 'name')
	const rawToken = readTrimmedStringOrEmpty(input.body, 'rawToken')
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
		...(await loadAccountPackageInvocationTokensData({
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
	const id = readTrimmedStringOrEmpty(input.body, 'id')
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
		await loadAccountPackageInvocationTokensData({
			env: input.env,
			request: input.request,
			user: input.user,
		}),
	)
}

async function handleReinstateAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const restored = await reinstatePackageInvocationToken({
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
		...(await loadAccountPackageInvocationTokensData({
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
	const id = readTrimmedStringOrEmpty(input.body, 'id')
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
		await loadAccountPackageInvocationTokensData({
			env: input.env,
			request: input.request,
			user: input.user,
		}),
	)
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
