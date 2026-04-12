import { expect, test } from 'vitest'
import {
	connectorIngressPath,
	connectorSessionKey,
	parseConnectorRoutePath,
} from './connector-session-key.ts'

test('connectorSessionKey preserves home instance id', () => {
	expect(connectorSessionKey('home', 'default')).toBe('default')
	expect(connectorSessionKey('HOME', 'living-room')).toBe('living-room')
})

test('connectorSessionKey prefixes home ids containing colons', () => {
	expect(connectorSessionKey('home', 'other:default')).toBe(
		'home:other:default',
	)
})

test('connectorSessionKey prefixes non-home kinds', () => {
	expect(connectorSessionKey('custom', 'alpha')).toBe('custom:alpha')
})

test('parseConnectorRoutePath handles generic and legacy paths', () => {
	expect(parseConnectorRoutePath('/connectors/custom/my-id/snapshot')).toEqual({
		kind: 'custom',
		instanceId: 'my-id',
		rest: '/snapshot',
	})
	expect(
		parseConnectorRoutePath('/home/connectors/default/rpc/tools-list'),
	).toEqual({
		kind: 'home',
		instanceId: 'default',
		rest: '/rpc/tools-list',
	})
	expect(parseConnectorRoutePath('/home/connectors')).toBeNull()
})

test('connectorIngressPath prefers legacy home URL', () => {
	expect(connectorIngressPath('home', 'default')).toBe(
		'/home/connectors/default',
	)
	expect(connectorIngressPath('custom', 'a b')).toBe('/connectors/custom/a%20b')
})
