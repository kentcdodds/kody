import statistics


async def main(params):
    values = params["values"]
    mean_val = float(statistics.mean(values))
    median_val = float(statistics.median(values))
    pstdev_val = float(statistics.pstdev(values))
    return {
        "mean": round(mean_val, 6),
        "median": round(median_val, 6),
        "pstdev": round(pstdev_val, 6),
    }
