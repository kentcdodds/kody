import { expect, test } from 'vitest'
import {
	parseUserScopedConnectorRoutePath,
	userScopedConnectorIngressPath,
	userScopedConnectorSessionKey,
} from './connector-session-key.ts'

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
	expect(a).toBe('["user-aaa","lights","default"]')
	expect(b).toBe('["user-bbb","lights","default"]')
})

test('userScopedConnectorSessionKey unambiguously encodes "/" in any segment', () => {
	// Two distinct tuples must never collapse onto the same DO id, even when a
	// component contains the segment delimiter.
	const collidingA = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		kind: 'lights',
		instanceId: 'a/b',
	})
	const collidingB = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		kind: 'lights/a',
		instanceId: 'b',
	})
	expect(collidingA).not.toBe(collidingB)
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
