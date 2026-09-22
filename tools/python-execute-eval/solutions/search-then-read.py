async def main(params):
    found = await kody.call("search", {"query": params["query"]})
    top = found["hits"][0]
    detail = await kody.call("notes.get", {"id": top["id"]})
    return {"id": top["id"], "text": detail["text"]}
