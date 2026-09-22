async def main(params):
    results = await kody.call("search", {"query": params["query"]})
    hit = results["hits"][0]
    return await kody.call("notes.get", {"id": hit["id"]})
