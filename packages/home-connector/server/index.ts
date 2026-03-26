import http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'
import { createHomeConnectorRouter } from '../app/router.ts'
import {
	captureHomeConnectorException,
	flushHomeConnectorSentry,
} from '../src/sentry.ts'
import { startHomeConnectorApp } from '../src/index.ts'

async function main() {
	const connector = await startHomeConnectorApp()
	const router = createHomeConnectorRouter(
		connector.state,
		connector.config,
		connector.lutron,
		connector.samsungTv,
	)

	const server = http.createServer(
		createRequestListener(
			async (request) => {
				try {
					return await router.fetch(request)
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							area: 'http',
						},
						contexts: {
							request: {
								method: request.method,
								url: request.url,
							},
						},
					})
					throw error
				}
			},
			{
				host: `localhost:${connector.config.port}`,
			},
		),
	)

	server.listen(connector.config.port, () => {
		console.info(
			`home-connector listening on http://localhost:${connector.config.port}`,
		)
	})
}

try {
	await main()
} catch (error) {
	captureHomeConnectorException(error, {
		tags: {
			area: 'startup',
		},
	})
	await flushHomeConnectorSentry()
	throw error
}
