import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from '#worker/package-runtime/package-app.ts'
import { packageRealtimeSessionRpc } from '#worker/package-runtime/realtime-session.ts'

function parsePackageAppPath(pathname: string) {
	const parts = pathname.split('/').filter(Boolean)
	if (parts[0] !== 'packages') return null
	const rawKodyId = parts[1]?.trim()
	if (!rawKodyId) return null
	let kodyId: string
	try {
		kodyId = decodeURIComponent(rawKodyId)
	} catch {
		return null
	}
	return {
		kodyId,
		restPath: parts.length > 2 ? `/${parts.slice(2).join('/')}` : '/',
	}
}

function parsePackageRealtimePath(restPath: string) {
	const parts = restPath.split('/').filter(Boolean)
	if (parts[0] !== 'ws') return null
	if (parts.length > 2) return null
	const rawFacet = parts[1]?.trim() ?? ''
	if (!rawFacet) {
		return {
			facet: null,
		}
	}
	try {
		return {
			facet: decodeURIComponent(rawFacet),
		}
	} catch {
		return null
	}
}

export async function handlePackageAppRequest(
	request: Request,
	env: Env,
	explicitKodyId?: string | null,
) {
	const packagePath = parsePackageAppPath(new URL(request.url).pathname)
	const kodyId = explicitKodyId?.trim() || packagePath?.kodyId || null
	if (!kodyId) {
		return new Response('Saved package app not found.', { status: 404 })
	}
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return redirectToLogin(request)
	}
	const savedPackage = await getSavedPackageByKodyId(env.APP_DB, {
		userId: user.mcpUser.userId,
		kodyId,
	})
	if (!savedPackage || !savedPackage.hasApp) {
		return new Response('Saved package app not found.', { status: 404 })
	}
	try {
		const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
		const packageRealtimePath = parsePackageRealtimePath(
			packagePath?.restPath ?? '/',
		)
		if (packageRealtimePath && request.headers.get('Upgrade') === 'websocket') {
			return await packageRealtimeSessionRpc({
				env,
				userId: user.mcpUser.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				baseUrl,
			}).connect(request, packageRealtimePath.facet)
		}
		const packageSource = await loadPackageSourceBySourceId({
			env,
			baseUrl,
			userId: user.mcpUser.userId,
			sourceId: savedPackage.sourceId,
		})
		const callerContext = await createPackageAppCallerContext({
			baseUrl,
			user: {
				userId: user.mcpUser.userId,
				email: user.email,
				displayName: user.displayName,
			},
			packageId: savedPackage.id,
		})
		const appWorker = await buildPackageAppWorker({
			env,
			baseUrl,
			userId: user.mcpUser.userId,
			savedPackage: {
				id: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
				sourceId: savedPackage.sourceId,
				publishedCommit: packageSource.source.published_commit,
				manifestPath: packageSource.source.manifest_path,
				sourceRoot: packageSource.source.source_root,
			},
			sourceFiles: packageSource.files,
			runtime: {
				callerContext,
			},
		})
		const entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName)
		const forwardedUrl = new URL(request.url)
		const resolvedPackagePath = parsePackageAppPath(forwardedUrl.pathname)
		if (!resolvedPackagePath || resolvedPackagePath.kodyId !== kodyId) {
			forwardedUrl.pathname = '/'
		} else {
			forwardedUrl.pathname = resolvedPackagePath.restPath
		}
		const forwardedRequest = new Request(forwardedUrl.toString(), request)
		return await entrypoint.fetch(forwardedRequest)
	} catch (error) {
		console.error('Package app handler failed:', error)
		return new Response('Internal Server Error', { status: 500 })
	}
}
