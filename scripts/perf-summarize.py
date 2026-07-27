#!/usr/bin/env python3
"""Print a metrics table from a directory of Lighthouse JSON reports.
Usage: python3 scripts/perf-summarize.py /tmp/lighthouse-before
"""
import json
import glob
import sys

outdir = sys.argv[1] if len(sys.argv) > 1 else "."
hdr = ["report", "score", "FCP_ms", "LCP_ms", "TTI_ms", "TBT_ms", "SpeedIndex_ms", "TotalKB"]
rows = []
for f in sorted(glob.glob(f"{outdir}/*.json")):
    d = json.load(open(f))
    audits = d["audits"]

    def ms(key):
        return round(audits[key]["numericValue"])

    total_bytes = audits.get("total-byte-weight", {}).get("numericValue")
    rows.append({
        "report": f.split("/")[-1].replace(".json", ""),
        "score": round(d["categories"]["performance"]["score"] * 100),
        "FCP_ms": ms("first-contentful-paint"),
        "LCP_ms": ms("largest-contentful-paint"),
        "TTI_ms": ms("interactive"),
        "TBT_ms": ms("total-blocking-time"),
        "SpeedIndex_ms": ms("speed-index"),
        "TotalKB": round(total_bytes / 1024) if total_bytes else None,
    })

print(" | ".join(hdr))
for r in rows:
    print(" | ".join(str(r[h]) for h in hdr))
