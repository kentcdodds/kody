import { expect, test } from 'vitest'
import { openSamsungRemoteSession } from './remote-client.ts'

class FakeSamsungWebSocket {
	static readonly OPEN = 1

	readyState = FakeSamsungWebSocket.OPEN
	private readonly listeners = new Map<
		string,
		Array<(event: Event | MessageEvent) => void>
	>()

	addEventListener(
		type: 'open' | 'message' | 'error' | 'close',
		listener: (event: Event | MessageEvent) => void,
	) {
		const existing = this.listeners.get(type) ?? []
		existing.push(listener)
		this.listeners.set(type, existing)
	}

	send(data: string) {
		if (!data.includes('ed.installedApp.get')) return
		queueMicrotask(() => {
			this.emit('message', {
				data: JSON.stringify({
					event: 'ms.channel.connect',
					data: {
						token: 'rotated-token',
					},
				}),
			} as MessageEvent)
		})
	}

	close() {
		this.emit('close', {} as Event)
	}

	private emit(type: string, event: Event | MessageEvent) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event)
		}
	}
}

test('openSamsungRemoteSession accepts token rotation after the auth probe', async () => {
	const session = await openSamsungRemoteSession({
		host: 'frame-tv.mock.local',
		token: null,
		timeoutMs: 1_000,
		webSocketFactory: () => new FakeSamsungWebSocket(),
	})

	expect(session.token).toBe('rotated-token')
	session.socket.close()
})
