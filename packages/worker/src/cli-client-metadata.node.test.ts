import { expect, test } from 'vitest'
import {
	buildCliClientIdMetadataDocument,
	cliClientIdMetadataPath,
	cliClientName,
	cliOAuthCallbackUrl,
	handleCliClientIdMetadataRequest,
} from './cli-client-metadata.ts'

test('CLI CIMD is origin-bound with a fixed loopback redirect', async () => {
	const origin = 'https://kody.codes'
	const documentUrl = `${origin}${cliClientIdMetadataPath}`
	const document = buildCliClientIdMetadataDocument(`${origin}/ignored`)
	expect(document.client_id).toBe(documentUrl)
	expect(document.client_name).toBe(cliClientName)
	expect(document.redirect_uris).toEqual([cliOAuthCallbackUrl])
	expect(document.token_endpoint_auth_method).toBe('none')
	expect(document.application_type).toBe('native')

	const getResponse = handleCliClientIdMetadataRequest(new Request(documentUrl))
	expect(getResponse?.status).toBe(200)
	expect(getResponse?.headers.get('Content-Type')).toBe('application/json')
	const body = (await getResponse?.json()) as {
		client_id: string
		redirect_uris: Array<string>
	}
	expect(body.client_id).toBe(documentUrl)
	expect(body.redirect_uris).toEqual([cliOAuthCallbackUrl])

	const headResponse = handleCliClientIdMetadataRequest(
		new Request(documentUrl, { method: 'HEAD' }),
	)
	expect(headResponse?.status).toBe(200)
	expect(await headResponse?.text()).toBe('')
	expect(
		handleCliClientIdMetadataRequest(
			new Request(documentUrl, { method: 'OPTIONS' }),
		)?.status,
	).toBe(204)
	expect(
		handleCliClientIdMetadataRequest(
			new Request(`${origin}/oauth/client-metadata.json`),
		),
	).toBeNull()
	expect(
		handleCliClientIdMetadataRequest(
			new Request(documentUrl, { method: 'POST' }),
		),
	).toBeNull()
})
