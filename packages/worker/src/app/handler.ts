import { setAuthSessionSecret } from '#app/auth-session.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { runWithDeferredWork } from '#worker/deferred-work.ts'
import { getEnv } from '#app/env.ts'
import {
	internalErrorPreviewPath,
	renderInternalServerErrorPage,
	retryHrefFromRequest,
} from '#app/internal-error-page.ts'
import { createAppRouter } from '#app/router.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { runWithRequestContext } from '#worker/request-context.ts'

type AppRouterBundle = {
	appEnv: Env
	router: ReturnType<typeof createAppRouter>
}

// Env binding objects are stable per isolate, so the parsed env and the
// router (which closes over env, not the request) can be built once instead
// of on every request. Keyed by identity so a new env object (new isolate or
// updated bindings) gets a fresh router.
const appRouterCache = new WeakMap<Env, AppRouterBundle>()

function getAppRouterBundle(env: Env): AppRouterBundle {
	let bundle = appRouterCache.get(env)
	if (!bundle) {
		const appEnv = getEnv(env)
		bundle = { appEnv, router: createAppRouter(appEnv) }
		appRouterCache.set(env, bundle)
	}
	return bundle
}

function renderIllustratedInternalErrorPage(input: {
	request: Request
	env: Env
}) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: 'Something went wrong',
		internalError: true,
		status: 500,
	})
}

async function recoverFromUncaughtHandlerFailure(input: {
	request: Request
	env: Env
}) {
	try {
		return await renderIllustratedInternalErrorPage(input)
	} catch (error) {
		console.error('Illustrated 500 shell failed:', error)
		return renderInternalServerErrorPage(retryHrefFromRequest(input.request))
	}
}

export async function handleRequest(
	request: Request,
	env: Env,
	ctx?: Pick<ExecutionContext, 'waitUntil'>,
) {
	try {
		const { appEnv, router } = getAppRouterBundle(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		if (
			isNonProductionRuntime(appEnv) &&
			new URL(request.url).pathname === internalErrorPreviewPath
		) {
			return await renderIllustratedInternalErrorPage({ request, env })
		}
		return await runWithDeferredWork(
			ctx ? (promise) => ctx.waitUntil(promise) : undefined,
			() => runWithRequestContext(request, () => router.fetch(request)),
		)
	} catch (error) {
		console.error('Remix server handler failed:', error)
		return recoverFromUncaughtHandlerFailure({ request, env })
	}
}
