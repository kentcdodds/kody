/**
 * Finish the unused side of a `request.clone()` tee. workerd treats an unread
 * cloned original as a leaked stream branch and can terminate the isolate;
 * wrangler 4.114+ then exits `wrangler dev` instead of recovering
 * (workers-sdk#14926, "Network connection lost").
 *
 * Use this on early-return paths after reading only the clone. Prefer reading
 * the original Request once when you do not need to forward it.
 */
export async function discardUnreadRequestBody(request: Request) {
	if (request.body === null || request.bodyUsed) return
	await request.arrayBuffer()
}
