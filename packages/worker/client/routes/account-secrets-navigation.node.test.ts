import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'

import { AccountSecretsRoute } from './account-secrets.tsx'

test('secrets management links to remote connector settings', async () => {
	const handle = {
		queueTask() {
			return
		},
		async update() {
			return new AbortController().signal
		},
		on() {
			return
		},
	} as unknown as Handle

	const render = AccountSecretsRoute(handle)
	const html = await renderToString(render())

	expect(html).toContain('href="/account/remote-connectors"')
	expect(html).toContain('Remote connectors')
	expect(html).toContain('New secret')
})
