import csv
import io


async def main(params):
    reader = csv.DictReader(io.StringIO(params["csv"]))
    by_sku = {}
    for row in reader:
        sku = row["sku"]
        qty = int(row["qty"])
        price = float(row["price"])
        if sku not in by_sku:
            by_sku[sku] = {"qty": 0, "revenue": 0.0}
        by_sku[sku]["qty"] += qty
        by_sku[sku]["revenue"] += qty * price
    return {"by_sku": by_sku}
