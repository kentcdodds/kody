import { route } from 'remix/fetch-router/routes'

export const routes = route({
	home: '/',
	health: '/health',
	rokuStatus: '/roku/status',
	rokuSetup: '/roku/setup',
})
