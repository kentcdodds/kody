import { expect, test } from 'vitest'
import {
	getRegisteredFrame,
	registerFrame,
	resolveRegisteredFrameHtml,
} from '#app/frame-registry.ts'
import { routes } from '#universal/routes.ts'

const env = {} as Env
const request = new Request('https://kody.local/pricing')

test('re-registering a frame name replaces the renderer instead of throwing', async () => {
	const name = `hmr-frame-${crypto.randomUUID()}`

	// First evaluation of a `frames/*.ts` module.
	registerFrame(name, {
		routes: [routes.pricing],
		render: () => '<p>first</p>',
	})

	// Vite HMR re-evaluates that module against the same, still-live registry
	// map. That used to throw "Frame name already registered" from the worker
	// entry import and take down every route until the dev server restarted.
	expect(() =>
		registerFrame(name, {
			routes: [routes.pricing],
			render: () => '<p>second</p>',
		}),
	).not.toThrow()

	const frame = getRegisteredFrame(name)
	expect(frame?.name).toBe(name)
	await expect(
		resolveRegisteredFrameHtml({
			src: '/pricing',
			target: name,
			request,
			env,
			pageUrl: new URL(request.url),
		}),
	).resolves.toBe('<p>second</p>')
})
