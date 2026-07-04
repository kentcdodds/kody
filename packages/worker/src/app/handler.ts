import { setAuthSessionSecret } from '#app/auth-session.ts'
import { getEnv } from '#app/env.ts'
import { createAppRouter } from '#app/router.ts'
import { type AppEnv } from '#worker/env-schema.ts'

type AppRouterBundle = {
	appEnv: AppEnv
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

export async function handleRequest(request: Request, env: Env) {
	try {
		const { appEnv, router } = getAppRouterBundle(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		return await router.fetch(request)
	} catch (error) {
		console.error('Remix server handler failed:', error)
		return new Response('Internal Server Error', { status: 500 })
	}
}
