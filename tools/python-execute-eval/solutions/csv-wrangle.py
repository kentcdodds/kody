import csv
import io


def main(params):
    totals = {}
    for row in csv.DictReader(io.StringIO(params["csv"])):
        sku = row["sku"]
        qty = int(row["qty"])
        revenue = qty * float(row["price"])
        current = totals.get(sku, {"qty": 0, "revenue": 0.0})
        current["qty"] += qty
        current["revenue"] += revenue
        totals[sku] = current
    return {"by_sku": totals}
