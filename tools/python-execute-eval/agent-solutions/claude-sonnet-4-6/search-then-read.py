async def main(params):
    results = await kody.call("search", {"query": params["query"]})
    hits = results.get("hits", [])
    if not hits:
        raise RuntimeError("No results found")
    note = await kody.call("notes.get", {"id": hits[0]["id"]})
    return note
