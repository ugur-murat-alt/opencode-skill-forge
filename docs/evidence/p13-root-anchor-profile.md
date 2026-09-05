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
  "warmup": {
    "requests": 500,
    "requested_rps": 100,
    "planned_duration_ms": 5000,
    "elapsed_ms": 5571.386200000001,
    "errors": 0,
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 26.55654338755981,
        "p95_ms": 39.649279,
        "max_ms": 114.032639,
        "observations": 209
      },
      "event_loop_utilization": 0.9977759707268766,
      "cpu_user_ms": 1938.066,
      "cpu_system_ms": 308.702,
      "resource_usage_fs_write_delta": 66000,
      "resource_usage_fs_read_delta": 0,
      "voluntary_context_switches": 19207,
      "involuntary_context_switches": 138,
      "gc": {
        "count": 5,
        "duration_ms": 27.526309847831726,
        "max_duration_ms": 6.588997006416321
      }
    },
    "latency": {
      "forge_search": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 501.7811049999982
      },
      "forge_load": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 1057.6478820000011
      }
    }
  },
  "load": {
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 26.07251456,
        "p95_ms": 38.010879,
        "max_ms": 79.822847,
        "observations": 125
      },
      "event_loop_utilization": 0.9991947207393985,
      "cpu_user_ms": 1326.808,
      "cpu_system_ms": 211.429,
      "resource_usage_fs_write_delta": 46768,
      "resource_usage_fs_read_delta": 0,
      "voluntary_context_switches": 10990,
      "involuntary_context_switches": 110,
      "gc": {
        "count": 4,
        "duration_ms": 33.88106107711792,
        "max_duration_ms": 19.076054096221924
      }
    },
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 3278.0198610000007,
    "achieved_rps": 91.51831940365884,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 17.306077000001096,
      "p95_ms": 71.47332299999835,
      "p99_ms": 81.73043099999995
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 90.75687399999879,
      "p95_ms": 537.7757600000004,
      "p99_ms": 565.9831579999991
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
        "elapsed_ms": 61934.917031,
        "latency": {
          "forge_search": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 175.4238370000021,
            "p95_ms": 989.2234339999995,
            "p99_ms": 10241.559766000006
          },
          "forge_load": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 2433.8288150000008,
            "p95_ms": 5046.310668999999,
            "p99_ms": 13028.901406000004
          }
        },
        "scheduler": {
          "max_delay_ms": 621.6985719999939,
          "max_scheduled_to_complete_ms": 17399.789651999992
        },
        "runtime": {
          "event_loop_delay": {
            "resolution_ms": 20,
            "mean_ms": 60.8628546705998,
            "p95_ms": 129.695743,
            "max_ms": 706.215935,
            "observations": 1017
          },
          "event_loop_utilization": 0.9999498055855451,
          "cpu_user_ms": 19294.434,
          "cpu_system_ms": 3668.841,
          "resource_usage_fs_write_delta": 1142800,
          "resource_usage_fs_read_delta": 232,
          "voluntary_context_switches": 212273,
          "involuntary_context_switches": 2824,
          "gc": {
            "count": 55,
            "duration_ms": 466.18023204803467,
            "max_duration_ms": 24.497800946235657
          }
        },
        "rss_bytes": 544948224,
        "heap_used_bytes": 113181104
      }
    ],
    "errors": 0,
    "requests": 6000,
    "status": "measured",
    "elapsed_ms": 61936.827947,
    "raw_samples_policy": "Per-minute exact quantiles; bounded minute buffer; no accumulated per-request heap."
  },
  "target_met": false
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

Soak katalog içindir; LLM, handoff, PostgreSQL yükü veya model kalitesi iddiası yoktur. Aynı host üzerindeki diğer işler sonuçları etkileyebilir.
