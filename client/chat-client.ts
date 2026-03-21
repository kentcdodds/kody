import {
	MessageType,
	type OutgoingMessage,
	type IncomingMessage,
} from '@cloudflare/ai-chat/types'
import { type UIMessage } from 'ai'
import { AgentClient } from 'agents/client'
import { createInfiniteList } from '#client/infinite-list.ts'
import { chatAgentBasePath } from '@kody-internal/shared/chat-routes.ts'

export type ChatClientSnapshot = {
	messages: Array<UIMessage>
	totalMessageCount: number
	streamingText: string
	isStreaming: boolean
	hasOlderMessages: boolean
	isLoadingMessages: boolean
	isLoadingOlderMessages: boolean
	error: string | null
	connected: boolean
}

type ChatClientOptions = {
	threadId: string
	onSnapshot: (snapshot: ChatClientSnapshot) => void
}

function createUserMessage(text: string): UIMessage {
	return {
		id: `user_${crypto.randomUUID()}`,
		role: 'user',
		parts: [{ type: 'text', text }],
	}
}

function buildChatAgentFetchUrl(threadId: string, suffix = '') {
	return new URL(
		`${chatAgentBasePath}/${threadId}${suffix}`,
		window.location.href,
	)
}

const initialMessagePageLimit = 40
const olderMessagePageLimit = 40

type ChatMessagesPageResponse = {
	ok?: boolean
	messages?: Array<UIMessage>
	hasMore?: boolean
	nextBefore?: string | null
	startIndex?: number
	totalCount?: number
	error?: string
}

export class ChatClient {
	private threadId: string
	private socket: AgentClient | null = null
	private activeRequestId: string | null = null
	private optimisticUserMessage: UIMessage | null = null
	private connectionWaiters = new Set<{
		resolve: () => void
		reject: (error: Error) => void
		timeoutId: number
	}>()
	private historyError: string | null = null
	private connectionError: string | null = null
	private actionError: string | null = null
	private loadedMessageStartIndex = 0
	private olderMessagesBeforeCursor: string | null = null
	private messageHistory = createInfiniteList<UIMessage>({
		mergeDirection: 'prepend',
		getKey: (message) => message.id,
		onSnapshot: (messageHistorySnapshot) => {
			this.historyError = messageHistorySnapshot.error
			this.syncSnapshot()
		},
	})
	private snapshot: ChatClientSnapshot = {
		messages: [],
		totalMessageCount: 0,
		streamingText: '',
		isStreaming: false,
		hasOlderMessages: false,
		isLoadingMessages: false,
		isLoadingOlderMessages: false,
		error: null,
		connected: false,
	}
	private onSnapshot: (snapshot: ChatClientSnapshot) => void

	constructor(options: ChatClientOptions) {
		this.threadId = options.threadId
		this.onSnapshot = options.onSnapshot
	}

	private emitSnapshot() {
		this.onSnapshot({ ...this.snapshot, messages: [...this.snapshot.messages] })
	}

	private syncSnapshot(next: Partial<ChatClientSnapshot> = {}) {
		const messageHistorySnapshot = this.messageHistory.getSnapshot()
		const messages = this.optimisticUserMessage
			? [...messageHistorySnapshot.items, this.optimisticUserMessage]
			: messageHistorySnapshot.items
		this.snapshot = {
			...this.snapshot,
			messages,
			totalMessageCount:
				messageHistorySnapshot.totalCount +
				(this.optimisticUserMessage ? 1 : 0),
			hasOlderMessages: messageHistorySnapshot.hasMore,
			isLoadingMessages: messageHistorySnapshot.isLoadingInitial,
			isLoadingOlderMessages: messageHistorySnapshot.isLoadingMore,
			error: this.actionError ?? this.historyError ?? this.connectionError,
			...next,
		}
		this.emitSnapshot()
	}

	private resolveConnectionWaiters() {
		for (const waiter of this.connectionWaiters) {
			window.clearTimeout(waiter.timeoutId)
			waiter.resolve()
		}
		this.connectionWaiters.clear()
	}

	private rejectConnectionWaiters(message: string) {
		for (const waiter of this.connectionWaiters) {
			window.clearTimeout(waiter.timeoutId)
			waiter.reject(new Error(message))
		}
		this.connectionWaiters.clear()
	}

	private async fetchMessagesPage(input?: {
		before?: string | null
		limit?: number
		signal?: AbortSignal
		start?: number | null
	}) {
		const url = buildChatAgentFetchUrl(this.threadId, '/get-messages')
		if (input?.before) {
			url.searchParams.set('before', input.before)
		}
		if (typeof input?.limit === 'number') {
			url.searchParams.set('limit', String(input.limit))
		}
		if (typeof input?.start === 'number') {
			url.searchParams.set('start', String(input.start))
		}
		const response = await fetch(url.toString(), {
			credentials: 'include',
			headers: { Accept: 'application/json' },
			signal: input?.signal,
		})
		if (!response.ok) {
			throw new Error(
				`Failed to reload chat messages (${response.status} ${response.statusText}).`,
			)
		}
		const payload = (await response
			.json()
			.catch(() => null)) as ChatMessagesPageResponse | null
		if (
			!payload?.ok ||
			!Array.isArray(payload.messages) ||
			typeof payload.totalCount !== 'number' ||
			typeof payload.hasMore !== 'boolean' ||
			typeof payload.startIndex !== 'number'
		) {
			throw new Error(payload?.error || 'Unable to read chat history.')
		}
		return payload
	}

	private async loadInitialMessages(signal?: AbortSignal) {
		let nextStartIndex = this.loadedMessageStartIndex
		let nextBeforeCursor: string | null = this.olderMessagesBeforeCursor
		const didLoad = await this.messageHistory.loadInitial(
			async ({ signal }) => {
				const page = await this.fetchMessagesPage({
					limit: initialMessagePageLimit,
					signal,
				})
				nextStartIndex = page.startIndex ?? 0
				nextBeforeCursor = page.nextBefore ?? null
				return {
					items: page.messages ?? [],
					hasMore: page.hasMore ?? false,
					totalCount: page.totalCount ?? 0,
				}
			},
			signal,
		)
		if (!didLoad) {
			throw new Error(this.historyError || 'Unable to load chat messages.')
		}
		this.loadedMessageStartIndex = nextStartIndex
		this.olderMessagesBeforeCursor = nextBeforeCursor
	}

	private async reloadLoadedMessages() {
		const page = await this.fetchMessagesPage({
			start: this.loadedMessageStartIndex,
		})
		this.loadedMessageStartIndex = page.startIndex ?? 0
		this.olderMessagesBeforeCursor = page.nextBefore ?? null
		this.messageHistory.replaceWindow({
			items: page.messages ?? [],
			hasMore: page.hasMore ?? false,
			totalCount: page.totalCount ?? 0,
		})
	}

	async initialize() {
		await this.loadInitialMessages()
		this.connect()
	}

	async loadOlderMessages(signal?: AbortSignal) {
		if (!this.olderMessagesBeforeCursor) return false
		let nextStartIndex = this.loadedMessageStartIndex
		let nextBeforeCursor: string | null = this.olderMessagesBeforeCursor
		const didLoad = await this.messageHistory.loadMore(async ({ signal }) => {
			const page = await this.fetchMessagesPage({
				before: this.olderMessagesBeforeCursor,
				limit: olderMessagePageLimit,
				signal,
			})
			nextStartIndex = page.startIndex ?? 0
			nextBeforeCursor = page.nextBefore ?? null
			return {
				items: page.messages ?? [],
				hasMore: page.hasMore ?? false,
				totalCount: page.totalCount ?? 0,
			}
		}, signal)
		if (didLoad) {
			this.loadedMessageStartIndex = nextStartIndex
			this.olderMessagesBeforeCursor = nextBeforeCursor
		}
		return didLoad
	}

	async waitUntilConnected(timeoutMs = 5_000) {
		if (this.snapshot.connected && this.socket?.readyState === WebSocket.OPEN)
			return

		await new Promise<void>((resolve, reject) => {
			const timeoutId = window.setTimeout(() => {
				this.connectionWaiters.delete(waiter)
				reject(new Error('Chat connection timed out. Please try again.'))
			}, timeoutMs)
			const waiter = {
				resolve,
				reject,
				timeoutId,
			}
			this.connectionWaiters.add(waiter)
		})
	}

	private connect() {
		if (this.socket) this.socket.close()
		const socket = new AgentClient({
			agent: 'chat-agent',
			name: this.threadId,
			host: window.location.host,
			protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
		})
		this.socket = socket

		socket.addEventListener('open', () => {
			this.connectionError = null
			this.syncSnapshot({ connected: true })
			this.resolveConnectionWaiters()
			socket.send(
				JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST }),
			)
		})

		socket.addEventListener('close', () => {
			const wasConnected = this.snapshot.connected
			if (this.socket === socket) this.socket = null
			this.syncSnapshot({ connected: false })
			if (!wasConnected) {
				this.rejectConnectionWaiters(
					'Chat connection closed before it was ready.',
				)
			}
		})

		socket.addEventListener('error', () => {
			this.connectionError =
				'Chat connection failed. Please refresh and try again.'
			this.syncSnapshot()
			this.rejectConnectionWaiters(
				'Chat connection failed. Please refresh and try again.',
			)
		})

		socket.addEventListener('message', (event) => {
			let data: unknown = null
			try {
				data = JSON.parse(String(event.data))
			} catch {
				return
			}
			if (!data || typeof data !== 'object' || !('type' in data)) return

			const message = data as OutgoingMessage
			switch (message.type) {
				case MessageType.CF_AGENT_CHAT_MESSAGES: {
					return
				}
				case MessageType.CF_AGENT_CHAT_CLEAR: {
					this.activeRequestId = null
					this.optimisticUserMessage = null
					this.loadedMessageStartIndex = 0
					this.olderMessagesBeforeCursor = null
					this.actionError = null
					this.historyError = null
					this.messageHistory.replaceWindow({
						items: [],
						hasMore: false,
						totalCount: 0,
					})
					this.syncSnapshot({
						streamingText: '',
						isStreaming: false,
					})
					return
				}
				case MessageType.CF_AGENT_STREAM_RESUMING: {
					socket.send(
						JSON.stringify({
							type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
							id: message.id,
						} satisfies IncomingMessage),
					)
					return
				}
				case MessageType.CF_AGENT_STREAM_RESUME_NONE: {
					return
				}
				case MessageType.CF_AGENT_USE_CHAT_RESPONSE: {
					if (message.id !== this.activeRequestId) return
					if (message.error) {
						this.activeRequestId = null
						this.optimisticUserMessage = null
						this.actionError = message.body || 'Chat generation failed.'
						this.syncSnapshot({ isStreaming: false, streamingText: '' })
						return
					}

					if (message.body?.trim()) {
						try {
							const chunk = JSON.parse(message.body) as {
								type?: string
								delta?: string
								value?: string
							}
							if (chunk.type === 'text-start') {
								this.syncSnapshot({ streamingText: '', isStreaming: true })
							} else if (chunk.type === 'text-delta' && chunk.delta) {
								this.syncSnapshot({
									isStreaming: true,
									streamingText: `${this.snapshot.streamingText}${chunk.delta}`,
								})
							} else if (chunk.type === 'text' && chunk.value) {
								this.syncSnapshot({
									isStreaming: true,
									streamingText: `${this.snapshot.streamingText}${chunk.value}`,
								})
							}
						} catch {
							// Ignore non-text chunks; the persisted message snapshot will catch up.
						}
					}

					if (message.done) {
						this.activeRequestId = null
						this.optimisticUserMessage = null
						this.actionError = null
						this.syncSnapshot({ isStreaming: false, streamingText: '' })
						void this.reloadLoadedMessages().catch((error: unknown) => {
							this.actionError =
								error instanceof Error
									? error.message
									: 'Unable to refresh chat messages.'
							this.syncSnapshot()
						})
					}
					return
				}
			}
		})
	}

	sendMessage(text: string) {
		const trimmed = text.trim()
		if (!trimmed) return
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error('Chat connection is not ready.')
		}

		const nextUserMessage = createUserMessage(trimmed)
		const nextMessages = [
			...this.messageHistory.getSnapshot().items,
			nextUserMessage,
		]
		const requestId = crypto.randomUUID()
		this.activeRequestId = requestId
		this.optimisticUserMessage = nextUserMessage
		this.actionError = null
		this.syncSnapshot({ streamingText: '', isStreaming: true })

		this.socket.send(
			JSON.stringify({
				type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
				id: requestId,
				init: {
					method: 'POST',
					body: JSON.stringify({
						messages: nextMessages,
						trigger: 'submit-message',
					}),
				},
			} satisfies IncomingMessage),
		)
	}

	async clearHistory() {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error('Chat connection is not ready.')
		}
		this.socket.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }))
	}

	close() {
		this.rejectConnectionWaiters('Chat connection closed.')
		this.socket?.close()
		this.socket = null
		this.connectionError = null
	}
}
