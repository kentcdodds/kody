import csv
import io


def main(params):
    by_sku = {}
    for row in csv.DictReader(io.StringIO(params["csv"])):
        sku = row["sku"]
        qty = int(row["qty"])
        price = float(row["price"])
        bucket = by_sku.setdefault(sku, {"qty": 0, "revenue": 0.0})
        bucket["qty"] += qty
        bucket["revenue"] += qty * price
    return {"by_sku": by_sku}
