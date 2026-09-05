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
    "elapsed_ms": 3007.0422909999998,
    "achieved_rps": 99.76559819963477,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 11.495702000000165,
      "p95_ms": 19.083865000000515,
      "p99_ms": 25.281143000000156
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 31.867365999998583,
      "p95_ms": 59.80344700000023,
      "p99_ms": 69.15125699999953
    }
  },
  "client_matrix": [
    {
      "requested_rps": 100,
      "requests": 300,
      "elapsed_ms": 3007.0422909999998,
      "achieved_rps": 99.76559819963477,
      "clients": 1,
      "pattern": "half search, half same-package load; overlapping official MCP calls",
      "latency": {
        "forge_search": {
          "n": 150,
          "p50_ms": 11.495702000000165,
          "p95_ms": 19.083865000000515,
          "p99_ms": 25.281143000000156
        },
        "forge_load": {
          "n": 150,
          "p50_ms": 31.867365999998583,
          "p95_ms": 59.80344700000023,
          "p99_ms": 69.15125699999953
        }
      },
      "errors": 0
    },
    {
      "clients": 10,
      "idle_control_clients": 1,
      "requests": 300,
      "requested_rps": 100,
      "achieved_rps": 99.94550557927722,
      "elapsed_ms": 3001.6357240000016,
      "connect_ms": 34.795523000000685,
      "latency": {
        "forge_search": {
          "n": 150,
          "p50_ms": 10.049501999999848,
          "p95_ms": 16.853140999999596,
          "p99_ms": 17.908998000000793
        },
        "forge_load": {
          "n": 150,
          "p50_ms": 11.397085999999035,
          "p95_ms": 35.434848000000784,
          "p99_ms": 50.65405699999974
        }
      },
      "errors": 0,
      "rss_bytes": 343334912
    },
    {
      "clients": 100,
      "idle_control_clients": 1,
      "requests": 300,
      "requested_rps": 100,
      "achieved_rps": 100.00117988058766,
      "elapsed_ms": 2999.9646040000007,
      "connect_ms": 363.63880699999936,
      "latency": {
        "forge_search": {
          "n": 150,
          "p50_ms": 6.932635000001028,
          "p95_ms": 11.32046999999875,
          "p99_ms": 16.250620999999228
        },
        "forge_load": {
          "n": 150,
          "p50_ms": 8.155900999998266,
          "p95_ms": 14.162093999999342,
          "p99_ms": 23.389008000001922
        }
      },
      "errors": 0,
      "rss_bytes": 346038272
    },
    {
      "clients": 1000,
      "idle_control_clients": 1,
      "requests": 1000,
      "requested_rps": 100,
      "achieved_rps": 99.97458317179391,
      "elapsed_ms": 10002.542329000004,
      "connect_ms": 3026.3767929999995,
      "latency": {
        "forge_search": {
          "n": 500,
          "p50_ms": 6.567784999999276,
          "p95_ms": 10.462682000001223,
          "p99_ms": 14.907576999998128
        },
        "forge_load": {
          "n": 500,
          "p50_ms": 7.545071000000462,
          "p95_ms": 11.16758800000025,
          "p99_ms": 20.54011999999784
        }
      },
      "errors": 0,
      "rss_bytes": 472915968
    }
  ],
  "target_met": true
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

1/10/100/1000 ayrı resmî MCP istemcisi; aynı yetkili kullanıcı/proje, farklı kullanıcı veya tenant ölçeği değildir.

OS cache was not flushed; startup integrity scan warms files.

No LLM, handoff, provider throughput, 30-minute soak, PostgreSQL load or model quality claim.
