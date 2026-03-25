import http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'
import { createHomeConnectorRouter } from '../app/router.ts'
import { startHomeConnectorApp } from '../src/index.ts'

const connector = await startHomeConnectorApp()
const router = createHomeConnectorRouter(connector.state, connector.config)

const server = http.createServer(
	createRequestListener((request) => router.fetch(request), {
		host: `localhost:${connector.config.port}`,
	}),
)

server.listen(connector.config.port, () => {
	console.info(
		`home-connector listening on http://localhost:${connector.config.port}`,
	)
})
