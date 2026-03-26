import { route } from 'remix/fetch-router/routes'

export const routes = route({
	home: '/',
	health: '/health',
	rokuStatus: '/roku/status',
	rokuSetup: '/roku/setup',
	lutronStatus: '/lutron/status',
	lutronSetup: '/lutron/setup',
	samsungTvStatus: '/samsung-tv/status',
	samsungTvSetup: '/samsung-tv/setup',
})
