import { DurableObject } from 'cloudflare:workers'

export class Sandbox extends DurableObject {}

export function getSandbox(): never {
	throw new Error('Sandbox SDK is not available in Node unit tests.')
}
