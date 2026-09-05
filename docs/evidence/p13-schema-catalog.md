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
    "elapsed_ms": 5659.280442999996,
    "errors": 0,
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 34.14212111515152,
        "p95_ms": 54.001663,
        "max_ms": 73.990143,
        "observations": 165
      },
      "event_loop_utilization": 0.9995195635330901,
      "cpu_user_ms": 2373.947,
      "cpu_system_ms": 250.458,
      "resource_usage_fs_write_delta": 65192,
      "resource_usage_fs_read_delta": 16,
      "voluntary_context_switches": 15228,
      "involuntary_context_switches": 359,
      "gc": {
        "count": 4,
        "duration_ms": 34.614301919937134,
        "max_duration_ms": 13.008805990219116
      }
    },
    "latency": {
      "forge_search": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 135.46334399999978
      },
      "forge_load": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 1251.8688280000024
      }
    }
  },
  "load": {
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 32.728743287128715,
        "p95_ms": 51.380223,
        "max_ms": 63.897599,
        "observations": 101
      },
      "event_loop_utilization": 0.9992436935267321,
      "cpu_user_ms": 1437.727,
      "cpu_system_ms": 148.245,
      "resource_usage_fs_write_delta": 45592,
      "resource_usage_fs_read_delta": 48,
      "voluntary_context_switches": 8976,
      "involuntary_context_switches": 191,
      "gc": {
        "count": 5,
        "duration_ms": 38.707805037498474,
        "max_duration_ms": 13.15274703502655
      }
    },
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 3334.4551830000055,
    "achieved_rps": 89.96951861499561,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 48.7110859999957,
      "p95_ms": 77.93124300000636,
      "p99_ms": 79.57913499999995
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 753.3630600000033,
      "p95_ms": 903.1505899999975,
      "p99_ms": 906.493094999998
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
        "elapsed_ms": 60050.879278,
        "latency": {
          "forge_search": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 43.958230999996886,
            "p95_ms": 112.61344600000302,
            "p99_ms": 167.9321659999987
          },
          "forge_load": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 640.4553549999982,
            "p95_ms": 1473.3550560000003,
            "p99_ms": 1581.5789050000021
          }
        },
        "scheduler": {
          "max_delay_ms": 144.3973249999981,
          "max_scheduled_to_complete_ms": 1664.0847520000025
        },
        "runtime": {
          "event_loop_delay": {
            "resolution_ms": 20,
            "mean_ms": 31.156509891022313,
            "p95_ms": 51.707903,
            "max_ms": 148.373503,
            "observations": 1927
          },
          "event_loop_utilization": 0.9989812097576984,
          "cpu_user_ms": 18416.331,
          "cpu_system_ms": 2887.504,
          "resource_usage_fs_write_delta": 1148016,
          "resource_usage_fs_read_delta": 96,
          "voluntary_context_switches": 177506,
          "involuntary_context_switches": 1852,
          "gc": {
            "count": 53,
            "duration_ms": 311.09059488773346,
            "max_duration_ms": 14.957433938980103
          }
        },
        "rss_bytes": 458924032,
        "heap_used_bytes": 228210152
      }
    ],
    "errors": 0,
    "requests": 6000,
    "status": "measured",
    "elapsed_ms": 60052.544559999995,
    "raw_samples_policy": "Per-minute exact quantiles; bounded minute buffer; no accumulated per-request heap."
  },
  "target_met": false
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

Soak katalog içindir; LLM, handoff, PostgreSQL yükü veya model kalitesi iddiası yoktur. Aynı host üzerindeki diğer işler sonuçları etkileyebilir.
