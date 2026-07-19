export type PlatformFeedbackDispatchQueueMessage = {
	feedbackId: string
}

export async function enqueuePlatformFeedbackDispatch(input: {
	queue: Pick<Queue<PlatformFeedbackDispatchQueueMessage>, 'send'>
	feedbackId: string
}) {
	await input.queue.send({ feedbackId: input.feedbackId })
}
