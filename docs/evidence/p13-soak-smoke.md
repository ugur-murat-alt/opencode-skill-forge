# Gerçek katalog ölçümü

Durum: measured. Paket: 10. Node: v24.19.0.

```json
{
  "context": {
    "ten_package_application_bytes": 2235,
    "catalog_application_bytes": 2235,
    "items": 5,
    "catalog_count": 10
  },
  "load": {
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 2998.093117,
    "achieved_rps": 100.06335377826666,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 7.269680999999991,
      "p95_ms": 15.907200000000103,
      "p99_ms": 20.077686000000085
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 8.38553200000024,
      "p95_ms": 81.6331839999998,
      "p99_ms": 125.58804599999985
    }
  },
  "soak": {
    "minutes": 1,
    "requested_rps": 100,
    "windows": [
      {
        "minute": 1,
        "requests": 6000,
        "errors": 0,
        "elapsed_ms": 60001.304559,
        "latency": {
          "forge_search": {
            "n": 3000,
            "p50_ms": 6.431099999994331,
            "p95_ms": 10.061646000001929,
            "p99_ms": 13.468489999999292
          },
          "forge_load": {
            "n": 3000,
            "p50_ms": 7.425357000000076,
            "p95_ms": 10.887794000002032,
            "p99_ms": 16.83364100000017
          }
        },
        "rss_bytes": 438288384,
        "heap_used_bytes": 182652960
      }
    ],
    "errors": 0,
    "requests": 6000,
    "status": "measured",
    "elapsed_ms": 60001.929357,
    "raw_samples_policy": "Per-minute exact quantiles; bounded minute buffer; no accumulated per-request heap."
  },
  "target_met": true
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

Soak katalog içindir; LLM, handoff, PostgreSQL yükü veya model kalitesi iddiası yoktur. Aynı host üzerindeki diğer işler sonuçları etkileyebilir.
