async def main(params):
    found = await kody.call("search", {"query": params["query"]})
    hit = found["hits"][0]
    return await kody.call("notes.get", {"id": hit["id"]})
