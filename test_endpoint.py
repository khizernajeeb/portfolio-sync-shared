"""Smoke test against the real confirmations, whose answers are already known."""
import base64, glob, sys
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)
PDFS = sorted(glob.glob("C:/Users/khizer.najeeb/Downloads/COAF21602*.pdf"))


def load(paths):
    return [{"name": "COAF21602.pdf", "content_type": "application/octet-stream",
             "data": base64.b64encode(open(p, "rb").read()).decode()} for p in paths]


print("health  :", client.get("/health").json())
print("brokers :", client.get("/brokers").json()[0]["name"])

recent = PDFS[-8:]
print(f"\nsending {len(recent)} real PDFs, empty sheet")
r = client.post("/parse", json={"broker": "akd", "pdfs": load(recent),
                                "known_rows": [], "sectors": {"DGKC": "Cement"}})
assert r.status_code == 200, r.text
out = r.json()
print(f"  pdfs read        : {out['pdfs_read']}")
print(f"  trades returned  : {len(out['trades'])}")
print(f"  duplicates       : {out['duplicates_skipped']}")
print(f"  new scrips       : {out['new_scrips']}")
print(f"  problems         : {out['problems']}")
for t in out["trades"]:
    side = f"debit {t['debit']:>12,.2f}" if t["debit"] else f"credit{t['credit']:>12,.2f}"
    print(f"    {t['date']}  {t['scrip']:<8}{t['type']:<5}{t['qty']:>6} @ {t['rate']:>10.4f}  {side}  [{t['sector'] or '-'}]")

print("\nsame PDFs again, but the sheet already has them")
known = [[t["scrip"], t["type"], t["qty"], t["rate"], t["notes"]] for t in out["trades"]]
r2 = client.post("/parse", json={"broker": "akd", "pdfs": load(recent),
                                 "known_rows": known, "sectors": {}}).json()
print(f"  trades returned  : {len(r2['trades'])}   (0 expected)")
print(f"  duplicates       : {r2['duplicates_skipped']}")

print("\ncorrupt input")
bad = client.post("/parse", json={"broker": "akd", "pdfs": [
    {"name": "x.pdf", "content_type": "application/pdf", "data": "bm90YXBkZg=="}],
    "known_rows": [], "sectors": {}}).json()
print(f"  problems         : {bad['problems'][0][:70]}...")
print(f"  trades           : {len(bad['trades'])}   (0 expected)")

print("\nunknown broker  :", client.post("/parse", json={"broker": "hbl", "pdfs": []}).status_code, "(400 expected)")
p = client.get("/prices?symbols=DGKC,LUCK,NOTAREALSCRIP").json()
print("prices          :", p["prices"], "| missing:", p["missing"])

ok = len(out["trades"]) > 0 and len(r2["trades"]) == 0 and len(bad["trades"]) == 0
print("\n", "ALL CHECKS PASSED" if ok else "SOMETHING FAILED")
sys.exit(0 if ok else 1)
