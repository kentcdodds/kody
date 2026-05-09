import { expect, test } from 'vitest'
import {
	connectorIngressPath,
	connectorSessionKey,
	parseConnectorRoutePath,
	parseUserScopedConnectorRoutePath,
	userScopedConnectorIngressPath,
	userScopedConnectorSessionKey,
} from './connector-session-key.ts'

test('connectorSessionKey prefixes connector ids with kind', () => {
	expect(connectorSessionKey('lights', 'default')).toBe('lights:default')
	expect(connectorSessionKey('LIGHTS', 'living-room')).toBe(
		'lights:living-room',
	)
	expect(connectorSessionKey('custom', 'alpha')).toBe('custom:alpha')
})

test('parseConnectorRoutePath handles connector paths', () => {
	expect(parseConnectorRoutePath('/connectors/custom/my-id/snapshot')).toEqual({
		kind: 'custom',
		instanceId: 'my-id',
		rest: '/snapshot',
	})
	expect(
		parseConnectorRoutePath('/connectors/lights/default/rpc/tools-list'),
	).toEqual({
		kind: 'lights',
		instanceId: 'default',
		rest: '/rpc/tools-list',
	})
	expect(parseConnectorRoutePath('/connectors/lights/default')).toEqual({
		kind: 'lights',
		instanceId: 'default',
		rest: '',
	})
	expect(parseConnectorRoutePath('/connectors/lights')).toBeNull()
})

test('connectorIngressPath creates connector URLs', () => {
	expect(connectorIngressPath('lights', 'default')).toBe(
		'/connectors/lights/default',
	)
	expect(connectorIngressPath('custom', 'a b')).toBe('/connectors/custom/a%20b')
})

test('userScopedConnectorSessionKey isolates connectors by user', () => {
	const a = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		kind: 'lights',
		instanceId: 'default',
	})
	const b = userScopedConnectorSessionKey({
		userId: 'user-bbb',
		kind: 'lights',
		instanceId: 'default',
	})
	expect(a).not.toBe(b)
	expect(a).toBe('u/user-aaa/lights/default')
	expect(b).toBe('u/user-bbb/lights/default')
})

test('userScopedConnectorIngressPath builds /connectors/u/... routes', () => {
	expect(
		userScopedConnectorIngressPath({
			userId: 'user-aaa',
			kind: 'lights',
			instanceId: 'living-room',
		}),
	).toBe('/connectors/u/user-aaa/lights/living-room')
	expect(
		userScopedConnectorIngressPath({
			userId: 'with space',
			kind: 'CUSTOM',
			instanceId: 'a b',
		}),
	).toBe('/connectors/u/with%20space/custom/a%20b')
})

test('parseUserScopedConnectorRoutePath extracts userId, kind, and instanceId', () => {
	expect(
		parseUserScopedConnectorRoutePath(
			'/connectors/u/user-aaa/lights/default/snapshot',
		),
	).toEqual({
		userId: 'user-aaa',
		kind: 'lights',
		instanceId: 'default',
		rest: '/snapshot',
	})
	expect(
		parseUserScopedConnectorRoutePath('/connectors/u/user-bbb/custom/abc'),
	).toEqual({
		userId: 'user-bbb',
		kind: 'custom',
		instanceId: 'abc',
		rest: '',
	})
	expect(
		parseUserScopedConnectorRoutePath('/connectors/lights/default'),
	).toBeNull()
	expect(
		parseUserScopedConnectorRoutePath('/connectors/u/user-aaa/lights'),
	).toBeNull()
})
