import { route } from 'remix/fetch-router/routes'

export const routes = route({
	home: '/',
	health: '/health',
	sentryTest: '/sentry/test',
	rokuStatus: '/roku/status',
	rokuSetup: '/roku/setup',
})
