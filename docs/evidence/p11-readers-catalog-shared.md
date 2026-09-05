# Gerçek katalog ölçümü

Durum: measured. Paket: 10000. Node: v24.19.0.

```json
{
  "context": {
    "ten_package_application_bytes": 2235,
    "catalog_application_bytes": 2240,
    "items": 5,
    "catalog_count": 10000
  },
  "load": {
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 3045.3012869999984,
    "achieved_rps": 98.5121558703674,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 15.026174999999057,
      "p95_ms": 24.817503999998735,
      "p99_ms": 30.696144000001368
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 110.96213500000158,
      "p95_ms": 186.18338599999697,
      "p99_ms": 207.1610440000004
    }
  },
  "target_met": true
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

LLM, handoff, sağlayıcı kapasitesi, 30 dakika soak, PostgreSQL yükü veya model kalitesi iddiası yoktur.
