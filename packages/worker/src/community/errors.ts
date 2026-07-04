export class CommunityActionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CommunityActionError'
	}
}
