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
	let shutdownPromise: Promise<void> | null = null

	async function closeServerWithWatchdog() {
		await new Promise<void>((resolve) => {
			const watchdog = setTimeout(() => {
				input.server.closeAllConnections()
				resolve()
			}, 5_000)
			input.server.close(() => {
				clearTimeout(watchdog)
				resolve()
			})
		})
	}

	function shutdown(reason: string) {
		if (shutdownPromise) {
			return shutdownPromise
		}

		shutdownPromise = (async () => {
			console.info(`Shutting down home connector reason=${reason}`)
			input.connector.workerConnector.stop()
			await closeServerWithWatchdog()
			await closeHomeConnectorSentry()
		})()

		return shutdownPromise
	}

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			// For clean termination, close the client so it stops accepting events
			// before the process exits.
			void shutdown(`signal:${signal}`).finally(() => {
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
		// On fatal process paths, flush buffered events but avoid relying on a full
		// async shutdown from an undefined runtime state.
		void flushHomeConnectorSentry().finally(() => {
			process.exit(1)
		})
	})

	process.once('unhandledRejection', (reason, _promise) => {
		captureHomeConnectorException(reason, {
			tags: {
				area: 'process',
				process_event: 'unhandledRejection',
			},
			extra: {
				...(typeof reason === 'string' ||
				typeof reason === 'number' ||
				typeof reason === 'boolean'
					? { reason: String(reason) }
					: {}),
				reasonType: typeof reason,
				...(reason instanceof Error ? { reasonName: reason.name } : {}),
			},
		})
		// On fatal process paths, flush buffered events but avoid relying on a full
		// async shutdown from an undefined runtime state.
		void flushHomeConnectorSentry().finally(() => {
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
		connector.accessNetworksUnleashed,
		connector.islandRouter,
		connector.islandRouterApi,
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
