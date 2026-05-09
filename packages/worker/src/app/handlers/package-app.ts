import * as Sentry from '@sentry/cloudflare'
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

function reportPackageAppFailure(input: {
	error: unknown
	phase: 'host-setup' | 'realtime-connect'
	requestUrl: URL
	kodyId: string
	packageId: string
	packageName: string
	sourceId: string
	forwardedPath: string
	realtimePath: string
}) {
	try {
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return

		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('package_app.phase', input.phase)
			scope.setTag('package_app.kody_id', input.kodyId)
			scope.setTag('package_app.package_id', input.packageId)
			scope.setTag('package_app.source_id', input.sourceId)
			scope.setContext('package_app', {
				phase: input.phase,
				kodyId: input.kodyId,
				packageId: input.packageId,
				packageName: input.packageName,
				sourceId: input.sourceId,
				forwardedPath: input.forwardedPath,
				realtimePath: input.realtimePath,
				hostPath: input.requestUrl.pathname,
			})
			Sentry.captureException(input.error)
		})
	} catch (sentryError) {
		console.warn('Failed to report package app failure to Sentry.', sentryError)
	}
}

export async function handlePackageAppRequest(
	request: Request,
	env: Env,
	explicitKodyId?: string | null,
) {
	const requestUrl = new URL(request.url)
	const packagePath = parsePackageAppPath(requestUrl.pathname)
	const kodyId = explicitKodyId?.trim() || packagePath?.kodyId || null
	if (!kodyId) {
		return new Response('Saved package app not found.', { status: 404 })
	}
	const packageRealtimeRestPath =
		packagePath?.kodyId === kodyId
			? packagePath.restPath
			: requestUrl.pathname || '/'
	const forwardedPackageRestPath =
		packagePath?.kodyId === kodyId ? packagePath.restPath : '/'
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
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	const packageRealtimePath = parsePackageRealtimePath(packageRealtimeRestPath)
	if (packageRealtimePath && request.headers.get('Upgrade') === 'websocket') {
		try {
			return await packageRealtimeSessionRpc({
				env,
				userId: user.mcpUser.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				baseUrl,
			}).connect(request, packageRealtimePath.facet)
		} catch (error) {
			console.error('Package realtime handler failed:', error)
			reportPackageAppFailure({
				error,
				phase: 'realtime-connect',
				requestUrl,
				kodyId: savedPackage.kodyId,
				packageId: savedPackage.id,
				packageName: savedPackage.name,
				sourceId: savedPackage.sourceId,
				forwardedPath: forwardedPackageRestPath,
				realtimePath: packageRealtimeRestPath,
			})
			return new Response('Internal Server Error', { status: 500 })
		}
	}

	let forwardedRequest: Request
	let entrypoint: { fetch(request: Request): Promise<Response> }
	try {
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
		entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName)
		const forwardedUrl = new URL(requestUrl)
		forwardedUrl.pathname = forwardedPackageRestPath
		forwardedRequest = new Request(forwardedUrl.toString(), request)
	} catch (error) {
		console.error('Package app handler failed:', error)
		reportPackageAppFailure({
			error,
			phase: 'host-setup',
			requestUrl,
			kodyId: savedPackage.kodyId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			sourceId: savedPackage.sourceId,
			forwardedPath: forwardedPackageRestPath,
			realtimePath: packageRealtimeRestPath,
		})
		return new Response('Internal Server Error', { status: 500 })
	}

	try {
		return await entrypoint.fetch(forwardedRequest)
	} catch (error) {
		console.error('Package app entrypoint failed:', error)
		return new Response('Internal Server Error', { status: 500 })
	}
}
