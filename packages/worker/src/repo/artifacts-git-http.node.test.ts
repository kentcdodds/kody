import { expect, test } from 'vitest'
import { isTransientArtifactsGitError } from './artifacts-git-retry.ts'
import {
	ArtifactsGitTimeoutError,
	createArtifactsGitHttp,
} from './artifacts-git-http.ts'

test('artifacts git http aborts a hung request and returns advertisement bytes', async () => {
	const hung = createArtifactsGitHttp({
		timeoutMs: 30,
		fetchImpl: (_url, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal
				if (!signal) {
					reject(new Error('missing abort signal'))
					return
				}
				signal.addEventListener('abort', () => {
					reject(
						signal.reason instanceof Error
							? signal.reason
							: new DOMException(
									'The operation was aborted due to timeout',
									'TimeoutError',
								),
					)
				})
			}),
	})
	const startedAt = Date.now()
	const timeoutError = await hung
		.request({
			url: 'https://example.test/info/refs?service=git-upload-pack',
		})
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(timeoutError).toBeInstanceOf(ArtifactsGitTimeoutError)
	expect(timeoutError).toMatchObject({
		message: 'Artifacts git request timed out after 30ms.',
	})
	expect(isTransientArtifactsGitError(timeoutError)).toBe(true)
	expect(Date.now() - startedAt).toBeLessThan(1_000)

	const ok = createArtifactsGitHttp({
		timeoutMs: 1_000,
		fetchImpl: async () =>
			new Response('001e# service=git-upload-pack\n', {
				status: 200,
				statusText: 'OK',
				headers: {
					'content-type': 'application/x-git-upload-pack-advertisement',
				},
			}),
	})
	const response = await ok.request({
		url: 'https://example.test/git/repo.git/info/refs?service=git-upload-pack',
		method: 'GET',
		headers: { accept: 'application/x-git-upload-pack-advertisement' },
	})
	expect(response.statusCode).toBe(200)
	expect(response.statusMessage).toBe('OK')
	expect(response.headers['content-type']).toBe(
		'application/x-git-upload-pack-advertisement',
	)
	const chunk = await response.body[Symbol.asyncIterator]().next()
	expect(chunk.value).toBeInstanceOf(Uint8Array)
	expect(new TextDecoder().decode(chunk.value)).toBe(
		'001e# service=git-upload-pack\n',
	)
})
