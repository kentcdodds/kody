import { expect, test } from 'vitest'
import {
	parseUserScopedConnectorRoutePath,
	userScopedConnectorIngressPath,
	userScopedConnectorSessionKey,
} from './connector-session-key.ts'

test('connector session keys and ingress routes round-trip without segment collisions', () => {
	const userA = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		kind: 'lights',
		instanceId: 'home',
	})
	const userB = userScopedConnectorSessionKey({
		userId: 'user-bbb',
		kind: 'lights',
		instanceId: 'home',
	})
	expect(userA).not.toBe(userB)
	expect(userA).toBe('["user-aaa","lights","home"]')

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

	expect(
		userScopedConnectorIngressPath({
			username: 'user-aaa',
			kind: 'lights',
			instanceId: 'living-room',
		}),
	).toBe('/@user-aaa/connectors/lights/living-room')
	expect(
		userScopedConnectorIngressPath({
			username: 'with space',
			kind: 'CUSTOM',
			instanceId: 'a b',
		}),
	).toBe('/@with%20space/connectors/custom/a%20b')

	expect(
		parseUserScopedConnectorRoutePath(
			'/@user-aaa/connectors/lights/home/snapshot',
		),
	).toEqual({
		username: 'user-aaa',
		kind: 'lights',
		instanceId: 'home',
		rest: '/snapshot',
	})
	expect(
		parseUserScopedConnectorRoutePath('/@user-bbb/connectors/custom/abc'),
	).toEqual({
		username: 'user-bbb',
		kind: 'custom',
		instanceId: 'abc',
		rest: '',
	})
	expect(
		parseUserScopedConnectorRoutePath('/connectors/lights/home'),
	).toBeNull()
	expect(
		parseUserScopedConnectorRoutePath('/@user-aaa/connectors/lights'),
	).toBeNull()
})
