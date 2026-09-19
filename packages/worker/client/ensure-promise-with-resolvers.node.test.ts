import { expect, test } from 'vitest'
import { ensurePromiseWithResolvers } from './ensure-promise-with-resolvers.ts'

type PromiseWithResolversResult<T> = {
	promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: unknown) => void
}

type PromiseWithResolversHost = {
	new <T>(
		executor: (
			resolve: (value: T | PromiseLike<T>) => void,
			reject: (reason?: unknown) => void,
		) => void,
	): Promise<T>
	withResolvers?: <T>() => PromiseWithResolversResult<T>
}

function createBarePromiseCtor(): PromiseWithResolversHost {
	return function BarePromise<T>(
		executor: (
			resolve: (value: T | PromiseLike<T>) => void,
			reject: (reason?: unknown) => void,
		) => void,
	): Promise<T> {
		return new Promise(executor)
	} as unknown as PromiseWithResolversHost
}

test('ensurePromiseWithResolvers polyfills missing withResolvers and leaves an existing implementation alone', async () => {
	const promiseWithoutWithResolvers = createBarePromiseCtor()

	ensurePromiseWithResolvers(promiseWithoutWithResolvers)

	expect(typeof promiseWithoutWithResolvers.withResolvers).toBe('function')

	const resolved = promiseWithoutWithResolvers.withResolvers!<string>()
	expect(resolved.promise).toBeInstanceOf(Promise)
	resolved.resolve('ok')
	await expect(resolved.promise).resolves.toBe('ok')

	const rejected = promiseWithoutWithResolvers.withResolvers!<never>()
	rejected.reject(new Error('nope'))
	await expect(rejected.promise).rejects.toThrow('nope')

	const existing = () => ({
		promise: Promise.resolve('already-present'),
		resolve() {},
		reject() {},
	})
	const promiseWithWithResolvers = Object.assign(createBarePromiseCtor(), {
		withResolvers: existing,
	})

	ensurePromiseWithResolvers(promiseWithWithResolvers)
	expect(promiseWithWithResolvers.withResolvers).toBe(existing)
	await expect(promiseWithWithResolvers.withResolvers().promise).resolves.toBe(
		'already-present',
	)
})
