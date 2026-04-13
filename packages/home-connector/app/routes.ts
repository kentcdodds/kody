import { route } from 'remix/fetch-router/routes'

export const routes = route({
	home: '/',
	health: '/health',
	rokuStatus: '/roku/status',
	rokuSetup: '/roku/setup',
	lutronStatus: '/lutron/status',
	lutronSetup: '/lutron/setup',
	sonosStatus: '/sonos/status',
	sonosSetup: '/sonos/setup',
	samsungTvStatus: '/samsung-tv/status',
	samsungTvSetup: '/samsung-tv/setup',
	bondStatus: '/bond/status',
	bondSetup: '/bond/setup',
	venstarStatus: '/venstar/status',
	venstarSetup: '/venstar/setup',
})
