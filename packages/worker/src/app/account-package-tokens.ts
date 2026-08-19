import { jsonResponse } from '#worker/json-response.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
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
import { getSavedPackageById } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function handleAccountPackageTokenAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	if (action === 'create-token') {
		return handleCreateToken(input)
	}
	if (action === 'update-token') {
		return handleUpdateToken(input)
	}
	if (action === 'revoke-token') {
		return handleRevokeToken(input)
	}
	if (action === 'reinstate-token') {
		return handleReinstateToken(input)
	}
	if (action === 'delete-token') {
		return handleDeleteToken(input)
	}
	return null
}

async function requireOwnedPackage(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	if (!packageId) {
		return {
			error: jsonResponse({ ok: false, error: 'Package id is required.' }, 400),
		}
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.user.mcpUser.userId,
		packageId,
	})
	if (!savedPackage) {
		return {
			error: jsonResponse({ ok: false, error: 'Package not found.' }, 404),
		}
	}
	return { packageId: savedPackage.id }
}

async function handleCreateToken(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const owned = await requireOwnedPackage(input)
	if ('error' in owned) return owned.error
	const name = readTrimmedStringOrEmpty(input.body, 'name')
	const rawToken = readTrimmedStringOrEmpty(input.body, 'rawToken')
	if (!name) {
		return jsonResponse({ ok: false, error: 'Token name is required.' }, 400)
	}
	if (!rawToken) {
		return jsonResponse({ ok: false, error: 'Raw token is required.' }, 400)
	}
	let exportNames: Array<string>
	try {
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
				error: error instanceof Error ? error.message : 'Invalid export scope.',
			},
			400,
		)
	}
	if (exportNames.length === 0) {
		return jsonResponse(
			{ ok: false, error: 'Choose at least one export scope.' },
			400,
		)
	}

	const tokenId = crypto.randomUUID()
	try {
		await insertPackageInvocationToken({
			db: input.env.APP_DB,
			row: {
				id: tokenId,
				userId: input.user.mcpUser.userId,
				packageId: owned.packageId,
				name,
				tokenHash: await hashPackageInvocationBearerToken(rawToken),
				exportNames,
			},
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : ''
		if (message.includes('UNIQUE') || message.includes('token_hash')) {
			return jsonResponse(
				{
					ok: false,
					error:
						'A package invocation token with that raw value already exists for this package.',
				},
				409,
			)
		}
		throw error
	}

	return jsonResponse({
		...(await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: owned.packageId,
		})),
		selectedTokenId: tokenId,
	})
}

async function handleUpdateToken(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const owned = await requireOwnedPackage(input)
	if ('error' in owned) return owned.error
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	const name = readTrimmedStringOrEmpty(input.body, 'name')
	const rawToken = readTrimmedStringOrEmpty(input.body, 'rawToken')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	if (!name) {
		return jsonResponse({ ok: false, error: 'Token name is required.' }, 400)
	}
	let exportNames: Array<string>
	try {
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
				error: error instanceof Error ? error.message : 'Invalid export scope.',
			},
			400,
		)
	}
	if (exportNames.length === 0) {
		return jsonResponse(
			{ ok: false, error: 'Choose at least one export scope.' },
			400,
		)
	}

	let updated: boolean
	try {
		updated = await updatePackageInvocationToken({
			db: input.env.APP_DB,
			userId: input.user.mcpUser.userId,
			packageId: owned.packageId,
			id,
			name,
			tokenHash: rawToken
				? await hashPackageInvocationBearerToken(rawToken)
				: undefined,
			exportNames,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : ''
		if (message.includes('UNIQUE') || message.includes('token_hash')) {
			return jsonResponse(
				{
					ok: false,
					error:
						'A package invocation token with that raw value already exists for this package.',
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
		...(await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: owned.packageId,
		})),
		selectedTokenId: id,
	})
}

async function handleRevokeToken(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const owned = await requireOwnedPackage(input)
	if ('error' in owned) return owned.error
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const revoked = await revokePackageInvocationToken({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		packageId: owned.packageId,
		id,
	})
	if (!revoked) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found.' },
			404,
		)
	}
	return jsonResponse(
		await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: owned.packageId,
		}),
	)
}

async function handleReinstateToken(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const owned = await requireOwnedPackage(input)
	if ('error' in owned) return owned.error
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const restored = await reinstatePackageInvocationToken({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		packageId: owned.packageId,
		id,
	})
	if (!restored) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found or active.' },
			404,
		)
	}
	return jsonResponse({
		...(await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: owned.packageId,
		})),
		selectedTokenId: id,
	})
}

async function handleDeleteToken(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}) {
	const owned = await requireOwnedPackage(input)
	if ('error' in owned) return owned.error
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	if (!id) {
		return jsonResponse({ ok: false, error: 'Token id is required.' }, 400)
	}
	const deleted = await deletePackageInvocationToken({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		packageId: owned.packageId,
		id,
	})
	if (!deleted) {
		return jsonResponse(
			{ ok: false, error: 'Package invocation token not found.' },
			404,
		)
	}
	return jsonResponse(
		await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: owned.packageId,
		}),
	)
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
