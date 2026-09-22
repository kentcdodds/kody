async def main(params):
    response = await kody.call("http.get", {"url": params["url"]})
    return {"status": response["status"], "value": response["json"]["value"]}
