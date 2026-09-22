async def main(params):
    response = await kody.call("http.get", {"url": params["url"]})
    body = response["json"]
    return {"status": response["status"], "value": body["value"]}
