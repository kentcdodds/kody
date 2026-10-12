import { expect, test } from 'vitest'
import {
	buildCapabilitySet,
	capabilitySetsEqual,
	dedupeCapabilityEntries,
	fingerprintCapabilityEntries,
} from './capability-set.ts'

test('fingerprint ignores via paths and display names', async () => {
	const first = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			name: 'OPENAI_KEY',
			credentialKind: 'secret',
			hosts: ['api.openai.com'],
			via: ['notes'],
		},
	])
	const second = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			name: 'Different display',
			credentialKind: 'secret',
			hosts: ['api.openai.com'],
			via: ['notes', 'helper'],
		},
	])
	expect(first).toBe(second)
	expect(capabilitySetsEqual(first, second)).toBe(true)
})

test('fingerprint changes when hosts or credential id change', async () => {
	const base = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['api.openai.com'],
			via: ['notes'],
		},
	])
	const hostChange = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['api.openai.com', 'cdn.openai.com'],
			via: ['notes'],
		},
	])
	const idChange = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-2',
			hosts: ['api.openai.com'],
			via: ['notes'],
		},
	])
	expect(base).not.toBe(hostChange)
	expect(base).not.toBe(idChange)
})

test('dedupe keeps a stable sorted set and prefers longer via', () => {
	const deduped = dedupeCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['B.example.com', 'a.example.com'],
			via: ['root'],
		},
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['a.example.com', 'b.example.com'],
			via: ['root', 'dep'],
		},
		{
			kind: 'storage',
			storageId: 'pkg-1',
			hosts: [],
			via: ['root'],
		},
	])
	expect(deduped).toHaveLength(2)
	expect(deduped[0]?.via).toEqual(['root', 'dep'])
	expect(deduped[0]?.hosts).toEqual(['a.example.com', 'b.example.com'])
})

test('buildCapabilitySet returns fingerprint matching entries', async () => {
	const set = await buildCapabilitySet([
		{
			kind: 'storage',
			storageId: 'pkg-1',
			hosts: [],
			via: ['notes'],
		},
	])
	expect(set.entries).toHaveLength(1)
	expect(set.fingerprint).toHaveLength(64)
})
