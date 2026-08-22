import { expect, test } from 'vitest'
import {
	isAppSurfaceOwnedRequest,
	isMainWorkerPlatformPath,
} from './app-worker-routing.ts'

function request(url: string) {
	return new Request(url)
}

test('app-surface owns Remix, blog, guides, and asset paths', () => {
	const env = {} as Env
	expect(isAppSurfaceOwnedRequest(request('https://kody.codes/'), env)).toBe(
		true,
	)
	expect(
		isAppSurfaceOwnedRequest(request('https://kody.codes/blog'), env),
	).toBe(true)
	expect(
		isAppSurfaceOwnedRequest(
			request('https://kody.codes/guides/what-is-kody'),
			env,
		),
	).toBe(true)
	expect(
		isAppSurfaceOwnedRequest(request('https://kody.codes/account'), env),
	).toBe(true)
	expect(
		isAppSurfaceOwnedRequest(request('https://kody.codes/styles.css'), env),
	).toBe(true)
	expect(
		isAppSurfaceOwnedRequest(
			request('https://kody.codes/client-entry.js'),
			env,
		),
	).toBe(true)
	expect(
		isAppSurfaceOwnedRequest(request('https://kody.codes/health'), env),
	).toBe(true)
})

test('app-surface does not own MCP, OAuth, or maintenance paths', () => {
	expect(isMainWorkerPlatformPath('/mcp')).toBe(true)
	expect(isMainWorkerPlatformPath('/mcp/')).toBe(true)
	expect(isMainWorkerPlatformPath('/oauth/authorize')).toBe(true)
	expect(
		isMainWorkerPlatformPath('/.well-known/oauth-protected-resource'),
	).toBe(true)
	expect(isMainWorkerPlatformPath('/__maintenance/reindex-capabilities')).toBe(
		true,
	)
	expect(isMainWorkerPlatformPath('/connectors/legacy')).toBe(true)
	expect(isMainWorkerPlatformPath('/blog')).toBe(false)
	expect(isMainWorkerPlatformPath('/guides/oauth')).toBe(false)
})
