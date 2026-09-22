import csv
import io


def main(params):
    totals = {}
    for row in csv.DictReader(io.StringIO(params["csv"])):
        sku = row["sku"]
        item = totals.setdefault(sku, {"qty": 0, "revenue": 0})
        quantity = int(row["qty"])
        item["qty"] += quantity
        item["revenue"] += quantity * float(row["price"])
    return {"by_sku": totals}
