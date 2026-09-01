import { type AccountPackageApprovePublishLoaderData } from '#universal/loader-data.ts'
import { getPackageTreeHref } from '#universal/package-files.ts'
import { routes } from '#universal/routes.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	isGitCommitSha,
	isSavedPackageLocked,
} from '#worker/package-registry/package-publish-lock.ts'
import {
	getSavedPackageById,
	setSavedPackageLockedAt,
} from '#worker/package-registry/repo.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountPackageApprovePublishData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	packageId: string
}): Promise<
	AccountPackageApprovePublishLoaderData | { ok: false; error: string }
> {
	const userId = input.user.mcpUser.userId
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		return { ok: false, error: 'Package not found.' }
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		savedPackage.sourceId,
	)
	if (!source || source.user_id !== userId) {
		return { ok: false, error: 'Package source not found.' }
	}
	const requestUrl = new URL(input.request.url)
	const requestedCommit = requestUrl.searchParams.get('commit')?.trim() ?? ''
	let pendingCommit: string | null = null
	if (requestedCommit) {
		if (!isGitCommitSha(requestedCommit)) {
			return { ok: false, error: 'The commit in this URL is not a git SHA.' }
		}
		pendingCommit = requestedCommit
	} else {
		const head = await resolveArtifactSourceHead(input.env, source.repo_id)
		pendingCommit = head.commit
	}
	const publishedCommit = source.published_commit
	return {
		ok: true,
		email: input.user.email,
		package: {
			id: savedPackage.id,
			name: savedPackage.name,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
			lockedAt: savedPackage.lockedAt,
		},
		publishedCommit,
		pendingCommit,
		alreadyPublished:
			pendingCommit != null &&
			publishedCommit != null &&
			pendingCommit === publishedCommit,
		filesHref: getPackageTreeHref({
			username: input.user.username,
			kodyId: savedPackage.kodyId,
		}),
		packageHref: routes.communityPackage.href({
			username: input.user.username,
			kodyId: savedPackage.kodyId,
		}),
	}
}

export async function handleAccountPackagePublishLockAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	if (
		action !== 'lock' &&
		action !== 'unlock' &&
		action !== 'approve-publish'
	) {
		return null
	}
	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	if (!packageId) {
		return jsonResponse({ ok: false, error: 'Package id is required.' }, 400)
	}
	const userId = input.user.mcpUser.userId
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId,
		packageId,
	})
	if (!savedPackage) {
		return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
	}

	if (action === 'lock' || action === 'unlock') {
		if (action === 'lock' && isSavedPackageLocked(savedPackage.lockedAt)) {
			return jsonResponse(
				await loadAccountPackagesData({
					env: input.env,
					request: input.request,
					user: input.user,
					pathPackageId: packageId,
				}),
			)
		}
		const changed = await setSavedPackageLockedAt(input.env.APP_DB, {
			userId,
			packageId,
			lockedAt: action === 'lock' ? new Date().toISOString() : null,
		})
		if (!changed) {
			return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
		}
		return jsonResponse(
			await loadAccountPackagesData({
				env: input.env,
				request: input.request,
				user: input.user,
				pathPackageId: packageId,
			}),
		)
	}

	const commit = readTrimmedStringOrEmpty(input.body, 'commit')
	if (!isGitCommitSha(commit)) {
		return jsonResponse(
			{
				ok: false,
				error: 'A git commit SHA is required to approve this publish.',
			},
			400,
		)
	}
	if (!isSavedPackageLocked(savedPackage.lockedAt)) {
		return jsonResponse(
			{ ok: false, error: 'This package is not locked.' },
			400,
		)
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		savedPackage.sourceId,
	)
	if (!source || source.user_id !== userId) {
		return jsonResponse({ ok: false, error: 'Package source not found.' }, 404)
	}
	const sessionId = `approve-publish-${savedPackage.id}`
	const publishResult = await repoSessionRpc(
		input.env,
		sessionId,
	).publishFromExternalRef({
		sessionId,
		sourceId: source.id,
		userId,
		newCommit: commit,
		allowLockedPublish: true,
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		rebuildPackageArtifacts: true,
	})
	switch (publishResult.status) {
		case 'published':
		case 'already_published':
			return jsonResponse(
				await loadAccountPackagesData({
					env: input.env,
					request: input.request,
					user: input.user,
					pathPackageId: packageId,
				}),
			)
		case 'checks_failed':
			return jsonResponse(
				{
					ok: false,
					error:
						'Publish checks failed for this commit. Fix the package and try again.',
					failed_checks: publishResult.failed_checks,
				},
				400,
			)
		case 'not_fast_forward':
			return jsonResponse({ ok: false, error: publishResult.message }, 400)
		case 'locked':
			return jsonResponse(
				{
					ok: false,
					error: 'Could not promote this locked package. Reload and try again.',
				},
				409,
			)
		default: {
			const exhaustive: never = publishResult
			throw new Error(`Unknown approve-publish status: ${String(exhaustive)}`)
		}
	}
}
