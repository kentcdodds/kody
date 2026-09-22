async def main(params):
    results = await kody.call("search", {"query": params["query"]})
    return await kody.call("notes.get", {"id": results["hits"][0]["id"]})
