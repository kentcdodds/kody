import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import {
	discoverRokuDevices,
	discoverRokuDevicesWithDiagnostics,
} from './client.ts'

async function createSsdpRokuFixture() {
	const deviceInfoXml = [
		'<device-info>',
		'<user-device-name>Living Room Roku</user-device-name>',
		'<serial-number>YH00AA123456</serial-number>',
		'<model-name>Roku Ultra</model-name>',
		'</device-info>',
	].join('')
	const httpServer = createServer((request, response) => {
		if (request.url === '/query/device-info') {
			response.writeHead(200, {
				'Content-Type': 'application/xml',
			})
			response.end(deviceInfoXml)
			return
		}

		response.writeHead(404)
		response.end('not found')
	})
	await new Promise<void>((resolve) => {
		httpServer.listen(0, '127.0.0.1', () => resolve())
	})
	const httpAddress = httpServer.address() as AddressInfo | null
	if (!httpAddress) {
		throw new Error('HTTP Roku fixture failed to bind.')
	}

	const socket = createSocket('udp4')
	await new Promise<void>((resolve) => {
		socket.bind(0, '127.0.0.1', () => resolve())
	})

	socket.on('message', (message, remote) => {
		const request = message.toString()
		if (!request.includes('ST: roku:ecp')) {
			return
		}

		const response = [
			'HTTP/1.1 200 OK',
			`LOCATION: http://127.0.0.1:${httpAddress.port}/`,
			'USN: uuid:roku:ecp:YH00AA123456',
			'ST: roku:ecp',
			'',
			'',
		].join('\r\n')

		socket.send(Buffer.from(response), remote.port, remote.address)
	})

	const address = socket.address()
	const ssdpPort =
		typeof address === 'string'
			? Number.parseInt(address.split(':').at(-1) || '0', 10)
			: address.port

	return {
		discoveryUrl: `ssdp://127.0.0.1:${ssdpPort}?timeoutMs=200`,
		[Symbol.asyncDispose]: async () => {
			socket.close()
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			})
		},
	}
}

test('roku SSDP discovery fetches live device details', async () => {
	await using fixture = await createSsdpRokuFixture()

	const devices = await discoverRokuDevices({
		discoveryUrl: fixture.discoveryUrl,
	})

	expect(devices).toHaveLength(1)
	expect(devices[0]).toMatchObject({
		id: 'YH00AA123456',
		name: 'Living Room Roku',
		location: expect.stringContaining('http://127.0.0.1:'),
		serialNumber: 'YH00AA123456',
		modelName: 'Roku Ultra',
		controlEnabled: true,
		isAdopted: false,
	})
})

test('roku SSDP discovery captures raw diagnostics', async () => {
	await using fixture = await createSsdpRokuFixture()

	const result = await discoverRokuDevicesWithDiagnostics({
		discoveryUrl: fixture.discoveryUrl,
	})

	expect(result.diagnostics.protocol).toBe('ssdp')
	expect(result.diagnostics.ssdpHits).toHaveLength(1)
	expect(result.diagnostics.ssdpHits[0]?.raw).toContain('HTTP/1.1 200 OK')
	expect(result.diagnostics.deviceInfoLookups).toHaveLength(1)
	expect(result.diagnostics.deviceInfoLookups[0]?.deviceInfoUrl).toContain(
		'/query/device-info',
	)
	expect(result.diagnostics.deviceInfoLookups[0]?.raw).toContain(
		'<serial-number>YH00AA123456</serial-number>',
	)
})
