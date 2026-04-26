import http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'
import { createHomeConnectorRouter } from '../app/router.ts'
import {
	closeHomeConnectorSentry,
	captureHomeConnectorException,
	flushHomeConnectorSentry,
} from '../src/sentry.ts'
import { startHomeConnectorApp } from '../src/index.ts'

const signalExitCodeByName = {
	SIGINT: 130,
	SIGTERM: 143,
} as const

function installGracefulShutdownHandlers(input: {
	server: http.Server
	connector: Awaited<ReturnType<typeof startHomeConnectorApp>>
}) {
	let isShuttingDown = false

	async function shutdown(reason: string, closeSentry: boolean) {
		if (isShuttingDown) {
			return
		}
		isShuttingDown = true
		console.info(`Shutting down home connector reason=${reason}`)
		input.connector.workerConnector.stop()
		await new Promise<void>((resolve) => {
			input.server.close(() => resolve())
		})
		if (closeSentry) {
			await closeHomeConnectorSentry()
			return
		}
		await flushHomeConnectorSentry()
	}

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			void shutdown(`signal:${signal}`, true).finally(() => {
				process.exit(signalExitCodeByName[signal])
			})
		})
	}

	process.once('uncaughtException', (error) => {
		captureHomeConnectorException(error, {
			tags: {
				area: 'process',
				process_event: 'uncaughtException',
			},
		})
		void shutdown('uncaughtException', true).finally(() => {
			process.exit(1)
		})
	})

	process.once('unhandledRejection', (reason) => {
		captureHomeConnectorException(reason, {
			tags: {
				area: 'process',
				process_event: 'unhandledRejection',
			},
		})
		void shutdown('unhandledRejection', true).finally(() => {
			process.exit(1)
		})
	})
}

async function main() {
	const connector = await startHomeConnectorApp()
	const router = createHomeConnectorRouter(
		connector.state,
		connector.config,
		connector.lutron,
		connector.samsungTv,
		connector.sonos,
		connector.bond,
		connector.jellyfish,
		connector.venstar,
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

	installGracefulShutdownHandlers({
		server,
		connector,
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
