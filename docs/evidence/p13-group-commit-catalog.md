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
  "warmup": {
    "requests": 500,
    "requested_rps": 100,
    "planned_duration_ms": 5000,
    "elapsed_ms": 5012.980532000001,
    "errors": 0,
    "sql": null,
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 25.288954775510202,
        "p95_ms": 36.012031,
        "max_ms": 61.145087,
        "observations": 196
      },
      "event_loop_utilization": 0.8929760404683692,
      "cpu_user_ms": 3341.653,
      "cpu_system_ms": 348.278,
      "resource_usage_fs_write_delta": 82008,
      "resource_usage_fs_read_delta": 8,
      "voluntary_context_switches": 15347,
      "involuntary_context_switches": 302,
      "gc": {
        "count": 5,
        "duration_ms": 55.04179382324219,
        "max_duration_ms": 15.834738969802856
      }
    },
    "latency": {
      "forge_search": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 46.3034439999974
      },
      "forge_load": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 77.94365999999718
      }
    }
  },
  "load": {
    "sql": null,
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 23.90654976,
        "p95_ms": 33.374207,
        "max_ms": 64.782335,
        "observations": 125
      },
      "event_loop_utilization": 0.7997303934399089,
      "cpu_user_ms": 1670.203,
      "cpu_system_ms": 255.5,
      "resource_usage_fs_write_delta": 71960,
      "resource_usage_fs_read_delta": 0,
      "voluntary_context_switches": 10566,
      "involuntary_context_switches": 178,
      "gc": {
        "count": 5,
        "duration_ms": 44.98436117172241,
        "max_duration_ms": 20.461976051330566
      }
    },
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 3010.7844990000012,
    "achieved_rps": 99.6415663020237,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 23.24660099999892,
      "p95_ms": 33.87435499999992,
      "p99_ms": 51.60003599999982
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 27.30086300000039,
      "p95_ms": 47.17987799999901,
      "p99_ms": 78.13921499999924
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
        "elapsed_ms": 60054.247689,
        "latency": {
          "forge_search": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 31.481746999997995,
            "p95_ms": 112.03089100000216,
            "p99_ms": 160.95574399999896
          },
          "forge_load": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 46.25204300000041,
            "p95_ms": 1234.2683990000005,
            "p99_ms": 1689.3645280000055
          }
        },
        "scheduler": {
          "max_delay_ms": 94.76511100000062,
          "max_scheduled_to_complete_ms": 1858.7646319999985
        },
        "sql": null,
        "runtime": {
          "event_loop_delay": {
            "resolution_ms": 20,
            "mean_ms": 28.988568784162243,
            "p95_ms": 50.823167,
            "max_ms": 120.258559,
            "observations": 2071
          },
          "event_loop_utilization": 0.8987482566062853,
          "cpu_user_ms": 35177.185,
          "cpu_system_ms": 5181.722,
          "resource_usage_fs_write_delta": 1463816,
          "resource_usage_fs_read_delta": 120,
          "voluntary_context_switches": 164009,
          "involuntary_context_switches": 3378,
          "gc": {
            "count": 59,
            "duration_ms": 778.2359834909439,
            "max_duration_ms": 35.32732605934143
          }
        },
        "rss_bytes": 467394560,
        "heap_used_bytes": 144094616
      }
    ],
    "errors": 0,
    "requests": 6000,
    "status": "measured",
    "elapsed_ms": 60060.010399000006,
    "raw_samples_policy": "Per-minute exact quantiles; bounded minute buffer; no accumulated per-request heap."
  },
  "target_met": false
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

Soak katalog içindir; LLM, handoff, PostgreSQL yükü veya model kalitesi iddiası yoktur. Aynı host üzerindeki diğer işler sonuçları etkileyebilir.
