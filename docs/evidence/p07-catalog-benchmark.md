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
    "elapsed_ms": 3033.833202,
    "achieved_rps": 98.88438918881906,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 9.979988999999478,
      "p95_ms": 22.473343999999997,
      "p99_ms": 26.086703999999372
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 12.350878999999622,
      "p95_ms": 145.76255599999968,
      "p99_ms": 153.22086900000068
    }
  },
  "target_met": true
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

One client with overlapping requests, not 10/100/1000 distinct clients.

OS cache was not flushed; startup integrity scan warms files.

No LLM, handoff, provider throughput, 30-minute soak, PostgreSQL load or model quality claim.
