import { post, route } from 'remix/fetch-router/routes'

export const routes = route({
	home: '/',
	chat: '/chat',
	chatThread: '/chat/:threadId',
	savedUi: '/ui/:id',
	savedUiData: '/ui-api/:id',
	savedUiExecute: post('/ui-api/:id/execute'),
	chatThreads: '/chat-threads',
	chatThreadsCreate: post('/chat-threads'),
	chatThreadsUpdate: post('/chat-threads/update'),
	chatThreadsDelete: post('/chat-threads/delete'),
	health: '/health',
	login: '/login',
	signup: '/signup',
	account: '/account',
	auth: post('/auth'),
	session: '/session',
	logout: post('/logout'),
	passwordResetRequest: post('/password-reset'),
	passwordResetConfirm: post('/password-reset/confirm'),
})
