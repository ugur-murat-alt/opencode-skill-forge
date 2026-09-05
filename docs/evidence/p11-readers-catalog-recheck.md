# Gerçek katalog ölçümü

Durum: measured. Paket: 10000. Node: v24.19.0.

```json
{
  "context": {
    "ten_package_application_bytes": 2235,
    "catalog_application_bytes": 2239,
    "items": 5,
    "catalog_count": 10000
  },
  "load": {
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 3214.8692360000023,
    "achieved_rps": 93.31618387998701,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 10.674874000000273,
      "p95_ms": 32.56777400000283,
      "p99_ms": 47.4309949999988
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 46.157869000000574,
      "p95_ms": 340.5670109999992,
      "p99_ms": 407.41016500000114
    }
  },
  "target_met": false
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

LLM, handoff, sağlayıcı kapasitesi, 30 dakika soak, PostgreSQL yükü veya model kalitesi iddiası yoktur.
