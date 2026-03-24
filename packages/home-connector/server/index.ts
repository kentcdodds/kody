import http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'
import { createAppRouter } from '../app/router.ts'
import { startHomeConnector } from '../src/index.ts'

const connector = await startHomeConnector()
const router = createAppRouter()

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
