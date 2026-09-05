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
    "elapsed_ms": 5782.508053999998,
    "errors": 0,
    "sql": [
      {
        "fingerprint": "64555e7ecd6567d85f2323ded7cf2697d8cff50c06eb42369bb20c95c66e0119",
        "operation": "delete",
        "table": "revision_readers",
        "calls": 400,
        "errors": 0,
        "synchronous_ms": 3162.5367259999502,
        "max_synchronous_ms": 19.989142999998876
      },
      {
        "fingerprint": "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
        "operation": "commit",
        "table": "other",
        "calls": 506,
        "errors": 0,
        "synchronous_ms": 2714.897125999998,
        "max_synchronous_ms": 16.481875000000173
      },
      {
        "fingerprint": "305a1a21eb900b32c5a8302250acb31ec964d695b0e79850efc2a4a8b97f3592",
        "operation": "insert",
        "table": "skill_observations",
        "calls": 252,
        "errors": 0,
        "synchronous_ms": 1883.1160659999878,
        "max_synchronous_ms": 18.571444000001065
      },
      {
        "fingerprint": "a3216614a5e14bd5108a78da73ac98f0f31edc7d28450e819f52e93759f3bafb",
        "operation": "insert",
        "table": "skill_observations",
        "calls": 251,
        "errors": 0,
        "synchronous_ms": 1671.2366639999818,
        "max_synchronous_ms": 16.447934000003443
      },
      {
        "fingerprint": "ca306c31286af106893b1e5b9897eb8d2ae2b9e74d2d66c9115d1d73c92e1a8b",
        "operation": "select",
        "table": "skill_revisions",
        "calls": 399,
        "errors": 0,
        "synchronous_ms": 905.1461690000497,
        "max_synchronous_ms": 7.949212999999872
      },
      {
        "fingerprint": "5692925ba7b9b221252af908b156fb17ae629886f48884c17f53e2663c8fe28f",
        "operation": "select",
        "table": "memberships",
        "calls": 2214,
        "errors": 0,
        "synchronous_ms": 323.9692370000396,
        "max_synchronous_ms": 2.5569430000000466
      },
      {
        "fingerprint": "0cd046f178e4fe9ade743438b86d0aab7af748943db194e6ac0304e0474b916c",
        "operation": "insert",
        "table": "revision_readers",
        "calls": 400,
        "errors": 0,
        "synchronous_ms": 128.2521169999941,
        "max_synchronous_ms": 5.9632890000011685
      },
      {
        "fingerprint": "1f60b540c9e416df82341f10a8910095caaea537618c9f9903f967e0cffcd1ee",
        "operation": "select",
        "table": "skills",
        "calls": 250,
        "errors": 0,
        "synchronous_ms": 55.70707299995411,
        "max_synchronous_ms": 0.534073000002536
      },
      {
        "fingerprint": "05437943355c4b70d7d0bcef665d77a335345f0353dfe465e913ba3b460d2d02",
        "operation": "select",
        "table": "projects",
        "calls": 1012,
        "errors": 0,
        "synchronous_ms": 44.98319400013929,
        "max_synchronous_ms": 0.19688099999621045
      },
      {
        "fingerprint": "e0b5c86f4de2f4b9e0afe979e5e59b5b0f9cd17919792e6d42ba8df40a7d6170",
        "operation": "update",
        "table": "tenants",
        "calls": 402,
        "errors": 0,
        "synchronous_ms": 34.00961999996798,
        "max_synchronous_ms": 0.61117700000068
      },
      {
        "fingerprint": "9ad33a863ec0e6c56c7ab8440d202618a7601fa3ae72eb23e4d15f092f8cbef3",
        "operation": "select",
        "table": "other",
        "calls": 103,
        "errors": 0,
        "synchronous_ms": 29.43037300001015,
        "max_synchronous_ms": 0.8327130000034231
      },
      {
        "fingerprint": "08c4f5156ccbe786c36e92e71b814f714e51714b87d6d90da53871c69a76b1ff",
        "operation": "delete",
        "table": "revision_readers",
        "calls": 2,
        "errors": 0,
        "synchronous_ms": 19.567934000006062,
        "max_synchronous_ms": 12.953379000005953
      },
      {
        "fingerprint": "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
        "operation": "begin",
        "table": "other",
        "calls": 506,
        "errors": 0,
        "synchronous_ms": 18.91617600000177,
        "max_synchronous_ms": 0.32762300000104005
      },
      {
        "fingerprint": "a69f97163e6472c407dba44c880e5ffad198efb822736f42e42037e229a18ea2",
        "operation": "select",
        "table": "other",
        "calls": 103,
        "errors": 0,
        "synchronous_ms": 6.686071999982232,
        "max_synchronous_ms": 0.23983299999963492
      },
      {
        "fingerprint": "3582caa18585ee29912441c115df9b3def543b2edd88951f75545f21de5e7719",
        "operation": "update",
        "table": "other",
        "calls": 103,
        "errors": 0,
        "synchronous_ms": 6.573420000000624,
        "max_synchronous_ms": 0.3045060000004014
      },
      {
        "fingerprint": "caf606d4d242946cb82c596dc986b07139751dafa38e6a5746ee012b820e1e72",
        "operation": "select",
        "table": "memberships",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 4.047904000000017,
        "max_synchronous_ms": 4.047904000000017
      },
      {
        "fingerprint": "c7150e229abbc91966320287f579608b271ba182d894f81fb665be26c6e1f3b4",
        "operation": "select",
        "table": "skill_revisions",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 4.037917000000107,
        "max_synchronous_ms": 4.037917000000107
      },
      {
        "fingerprint": "789c267fe10e718b9f9b3cfe10f88d636b8f382dd50d2bb552516ef8cc672db2",
        "operation": "select",
        "table": "skills",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.8876069999969332,
        "max_synchronous_ms": 0.8876069999969332
      },
      {
        "fingerprint": "fea75d119442a1915da7419bc09adf2725976ae9d51afba77902bbbad2ddc080",
        "operation": "select",
        "table": "skills",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.8232130000033067,
        "max_synchronous_ms": 0.8232130000033067
      },
      {
        "fingerprint": "b443d6961cc02a67dd4bfb991d1a9316d3132dee1bd69b9e21fe8ff9ab695cb5",
        "operation": "select",
        "table": "other",
        "calls": 3,
        "errors": 0,
        "synchronous_ms": 0.5733240000001842,
        "max_synchronous_ms": 0.40186400000015965
      },
      {
        "fingerprint": "0b12ca678fb24174c0acc4c7e06ec9c27d7db80c1512fb7bff72736a0b8ebe45",
        "operation": "select",
        "table": "skill_revisions",
        "calls": 2,
        "errors": 0,
        "synchronous_ms": 0.5217799999954877,
        "max_synchronous_ms": 0.2890709999992396
      },
      {
        "fingerprint": "cca941246624cb77368f08ba1ee06b3c17ed154e680c0d32f0dc338985fd11c6",
        "operation": "select",
        "table": "other",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.49859399999991183,
        "max_synchronous_ms": 0.49859399999991183
      },
      {
        "fingerprint": "dbf053d65f68204ff835c1688fe3781e39964838f6ec2086bba8fb1b32435fd3",
        "operation": "select",
        "table": "skills",
        "calls": 2,
        "errors": 0,
        "synchronous_ms": 0.47833900000114227,
        "max_synchronous_ms": 0.3167280000052415
      },
      {
        "fingerprint": "eb48d16fbdada127f9a2d06df638f4a7074586ab995573bd433a89ad44fb1720",
        "operation": "select",
        "table": "skill_observations",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.2980800000000272,
        "max_synchronous_ms": 0.2980800000000272
      },
      {
        "fingerprint": "3b39801ac30e76669637eec0c4703945d3660e8fbdcbd0513cf8212f4e7dee8b",
        "operation": "select",
        "table": "audit_events",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.2957760000001599,
        "max_synchronous_ms": 0.2957760000001599
      },
      {
        "fingerprint": "5cfc520bdee576277d7fde8be191d1282244eb5338817f0f7a8e9900b5d22e70",
        "operation": "select",
        "table": "other",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.2827159999999367,
        "max_synchronous_ms": 0.2827159999999367
      },
      {
        "fingerprint": "64f17e6e5b42a4ba38d5064b71274d45e0d421a3eb23a1102fe2ff2a2c005acb",
        "operation": "select",
        "table": "other",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.25380199999995057,
        "max_synchronous_ms": 0.25380199999995057
      },
      {
        "fingerprint": "c08d0f81ef4e0697b510c883c287633b6857733e81ec6774e28a8d79778e9734",
        "operation": "insert",
        "table": "revision_readers",
        "calls": 2,
        "errors": 0,
        "synchronous_ms": 0.1476429999966058,
        "max_synchronous_ms": 0.07472899999993388
      },
      {
        "fingerprint": "2bdd5b0dc86746fa5717badfc183547c4b5a5cdb1c80fc8967c0ae6949eec552",
        "operation": "select",
        "table": "other",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.07473000000004504,
        "max_synchronous_ms": 0.07473000000004504
      }
    ],
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 35.152771121951226,
        "p95_ms": 56.590335,
        "max_ms": 67.764223,
        "observations": 164
      },
      "event_loop_utilization": 0.999754977573296,
      "cpu_user_ms": 2551.558,
      "cpu_system_ms": 338.816,
      "resource_usage_fs_write_delta": 65424,
      "resource_usage_fs_read_delta": 48,
      "voluntary_context_switches": 11969,
      "involuntary_context_switches": 231,
      "gc": {
        "count": 5,
        "duration_ms": 44.85520100593567,
        "max_duration_ms": 10.317654967308044
      }
    },
    "latency": {
      "forge_search": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 134.3520320000025
      },
      "forge_load": {
        "n": 250,
        "includes_failed_calls": true,
        "p95_ms": 1653.621137000002
      }
    }
  },
  "load": {
    "sql": [
      {
        "fingerprint": "305a1a21eb900b32c5a8302250acb31ec964d695b0e79850efc2a4a8b97f3592",
        "operation": "insert",
        "table": "skill_observations",
        "calls": 150,
        "errors": 0,
        "synchronous_ms": 1169.3310109999948,
        "max_synchronous_ms": 18.474715000003926
      },
      {
        "fingerprint": "a3216614a5e14bd5108a78da73ac98f0f31edc7d28450e819f52e93759f3bafb",
        "operation": "insert",
        "table": "skill_observations",
        "calls": 150,
        "errors": 0,
        "synchronous_ms": 1053.737952999989,
        "max_synchronous_ms": 17.43282999999792
      },
      {
        "fingerprint": "5692925ba7b9b221252af908b156fb17ae629886f48884c17f53e2663c8fe28f",
        "operation": "select",
        "table": "memberships",
        "calls": 601,
        "errors": 0,
        "synchronous_ms": 62.59957900001609,
        "max_synchronous_ms": 0.5407770000019809
      },
      {
        "fingerprint": "1f60b540c9e416df82341f10a8910095caaea537618c9f9903f967e0cffcd1ee",
        "operation": "select",
        "table": "skills",
        "calls": 150,
        "errors": 0,
        "synchronous_ms": 33.03646099995967,
        "max_synchronous_ms": 0.5349109999951907
      },
      {
        "fingerprint": "05437943355c4b70d7d0bcef665d77a335345f0353dfe465e913ba3b460d2d02",
        "operation": "select",
        "table": "projects",
        "calls": 601,
        "errors": 0,
        "synchronous_ms": 26.757074999812176,
        "max_synchronous_ms": 0.20128099999419646
      },
      {
        "fingerprint": "9ad33a863ec0e6c56c7ab8440d202618a7601fa3ae72eb23e4d15f092f8cbef3",
        "operation": "select",
        "table": "other",
        "calls": 61,
        "errors": 0,
        "synchronous_ms": 16.052844000012556,
        "max_synchronous_ms": 0.6055899999992107
      },
      {
        "fingerprint": "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
        "operation": "commit",
        "table": "other",
        "calls": 62,
        "errors": 0,
        "synchronous_ms": 7.6065030000245315,
        "max_synchronous_ms": 6.024679000001925
      },
      {
        "fingerprint": "08c4f5156ccbe786c36e92e71b814f714e51714b87d6d90da53871c69a76b1ff",
        "operation": "delete",
        "table": "revision_readers",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 6.142222000002221,
        "max_synchronous_ms": 6.142222000002221
      },
      {
        "fingerprint": "a69f97163e6472c407dba44c880e5ffad198efb822736f42e42037e229a18ea2",
        "operation": "select",
        "table": "other",
        "calls": 61,
        "errors": 0,
        "synchronous_ms": 3.6905269999915618,
        "max_synchronous_ms": 0.17739499999879627
      },
      {
        "fingerprint": "3582caa18585ee29912441c115df9b3def543b2edd88951f75545f21de5e7719",
        "operation": "update",
        "table": "other",
        "calls": 61,
        "errors": 0,
        "synchronous_ms": 3.6879399999961606,
        "max_synchronous_ms": 0.24584000000322703
      },
      {
        "fingerprint": "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
        "operation": "begin",
        "table": "other",
        "calls": 62,
        "errors": 0,
        "synchronous_ms": 2.7670279999947525,
        "max_synchronous_ms": 0.16175099999964004
      },
      {
        "fingerprint": "dbf053d65f68204ff835c1688fe3781e39964838f6ec2086bba8fb1b32435fd3",
        "operation": "select",
        "table": "skills",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.10902099999657366,
        "max_synchronous_ms": 0.10902099999657366
      },
      {
        "fingerprint": "c08d0f81ef4e0697b510c883c287633b6857733e81ec6774e28a8d79778e9734",
        "operation": "insert",
        "table": "revision_readers",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.0924689999956172,
        "max_synchronous_ms": 0.0924689999956172
      },
      {
        "fingerprint": "0b12ca678fb24174c0acc4c7e06ec9c27d7db80c1512fb7bff72736a0b8ebe45",
        "operation": "select",
        "table": "skill_revisions",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.0643939999936265,
        "max_synchronous_ms": 0.0643939999936265
      },
      {
        "fingerprint": "e0b5c86f4de2f4b9e0afe979e5e59b5b0f9cd17919792e6d42ba8df40a7d6170",
        "operation": "update",
        "table": "tenants",
        "calls": 1,
        "errors": 0,
        "synchronous_ms": 0.04497700000501936,
        "max_synchronous_ms": 0.04497700000501936
      }
    ],
    "runtime": {
      "event_loop_delay": {
        "resolution_ms": 20,
        "mean_ms": 31.942395345454543,
        "p95_ms": 59.277311,
        "max_ms": 71.434239,
        "observations": 110
      },
      "event_loop_utilization": 0.9996730251334875,
      "cpu_user_ms": 1639.752,
      "cpu_system_ms": 179.585,
      "resource_usage_fs_write_delta": 46816,
      "resource_usage_fs_read_delta": 0,
      "voluntary_context_switches": 7229,
      "involuntary_context_switches": 245,
      "gc": {
        "count": 4,
        "duration_ms": 36.3777129650116,
        "max_duration_ms": 16.075194001197815
      }
    },
    "requested_rps": 100,
    "requests": 300,
    "elapsed_ms": 3534.462931000002,
    "achieved_rps": 84.87822304334645,
    "clients": 1,
    "pattern": "half search, half same-package load; overlapping official MCP calls"
  },
  "latency": {
    "forge_search": {
      "n": 150,
      "p50_ms": 49.03154400000494,
      "p95_ms": 112.40965099999448,
      "p99_ms": 113.9847710000031
    },
    "forge_load": {
      "n": 150,
      "p50_ms": 819.5390239999979,
      "p95_ms": 1090.3727480000016,
      "p99_ms": 1116.8713359999965
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
        "elapsed_ms": 78270.846486,
        "latency": {
          "forge_search": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 267.287427999996,
            "p95_ms": 17176.130309999993,
            "p99_ms": 18590.262982
          },
          "forge_load": {
            "n": 3000,
            "includes_failed_calls": true,
            "p50_ms": 4049.488043000005,
            "p95_ms": 17981.792727000007,
            "p99_ms": 19167.19739
          }
        },
        "scheduler": {
          "max_delay_ms": 497.93849200000113,
          "max_scheduled_to_complete_ms": 20215.703504999998
        },
        "sql": [
          {
            "fingerprint": "305a1a21eb900b32c5a8302250acb31ec964d695b0e79850efc2a4a8b97f3592",
            "operation": "insert",
            "table": "skill_observations",
            "calls": 3000,
            "errors": 0,
            "synchronous_ms": 24701.792875000407,
            "max_synchronous_ms": 41.89968200000294
          },
          {
            "fingerprint": "a3216614a5e14bd5108a78da73ac98f0f31edc7d28450e819f52e93759f3bafb",
            "operation": "insert",
            "table": "skill_observations",
            "calls": 3000,
            "errors": 0,
            "synchronous_ms": 21599.578152999813,
            "max_synchronous_ms": 34.81383999998798
          },
          {
            "fingerprint": "5692925ba7b9b221252af908b156fb17ae629886f48884c17f53e2663c8fe28f",
            "operation": "select",
            "table": "memberships",
            "calls": 12014,
            "errors": 0,
            "synchronous_ms": 1685.6014479995647,
            "max_synchronous_ms": 4.003485999986879
          },
          {
            "fingerprint": "1f60b540c9e416df82341f10a8910095caaea537618c9f9903f967e0cffcd1ee",
            "operation": "select",
            "table": "skills",
            "calls": 3000,
            "errors": 0,
            "synchronous_ms": 954.5882009999987,
            "max_synchronous_ms": 3.365769000010914
          },
          {
            "fingerprint": "05437943355c4b70d7d0bcef665d77a335345f0353dfe465e913ba3b460d2d02",
            "operation": "select",
            "table": "projects",
            "calls": 12010,
            "errors": 0,
            "synchronous_ms": 633.1241460004967,
            "max_synchronous_ms": 2.4792100000049686
          },
          {
            "fingerprint": "9ad33a863ec0e6c56c7ab8440d202618a7601fa3ae72eb23e4d15f092f8cbef3",
            "operation": "select",
            "table": "other",
            "calls": 1054,
            "errors": 0,
            "synchronous_ms": 511.14543899992714,
            "max_synchronous_ms": 9.047251000010874
          },
          {
            "fingerprint": "3582caa18585ee29912441c115df9b3def543b2edd88951f75545f21de5e7719",
            "operation": "update",
            "table": "other",
            "calls": 1054,
            "errors": 0,
            "synchronous_ms": 229.36434699984238,
            "max_synchronous_ms": 17.278552999996464
          },
          {
            "fingerprint": "a69f97163e6472c407dba44c880e5ffad198efb822736f42e42037e229a18ea2",
            "operation": "select",
            "table": "other",
            "calls": 1054,
            "errors": 0,
            "synchronous_ms": 117.8689689999519,
            "max_synchronous_ms": 1.7445540000044275
          },
          {
            "fingerprint": "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
            "operation": "begin",
            "table": "other",
            "calls": 1058,
            "errors": 0,
            "synchronous_ms": 85.3012849999941,
            "max_synchronous_ms": 2.318156999986968
          },
          {
            "fingerprint": "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
            "operation": "commit",
            "table": "other",
            "calls": 1058,
            "errors": 0,
            "synchronous_ms": 54.723935999958485,
            "max_synchronous_ms": 6.365711999998894
          },
          {
            "fingerprint": "08c4f5156ccbe786c36e92e71b814f714e51714b87d6d90da53871c69a76b1ff",
            "operation": "delete",
            "table": "revision_readers",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 12.630574999995588,
            "max_synchronous_ms": 6.687817999998515
          },
          {
            "fingerprint": "eb48d16fbdada127f9a2d06df638f4a7074586ab995573bd433a89ad44fb1720",
            "operation": "select",
            "table": "skill_observations",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 9.411820000001171,
            "max_synchronous_ms": 8.745957999999519
          },
          {
            "fingerprint": "caf606d4d242946cb82c596dc986b07139751dafa38e6a5746ee012b820e1e72",
            "operation": "select",
            "table": "memberships",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.6125750000064727,
            "max_synchronous_ms": 0.34641100000590086
          },
          {
            "fingerprint": "b443d6961cc02a67dd4bfb991d1a9316d3132dee1bd69b9e21fe8ff9ab695cb5",
            "operation": "select",
            "table": "other",
            "calls": 6,
            "errors": 0,
            "synchronous_ms": 0.5921820000148728,
            "max_synchronous_ms": 0.16782800000510179
          },
          {
            "fingerprint": "5cfc520bdee576277d7fde8be191d1282244eb5338817f0f7a8e9900b5d22e70",
            "operation": "select",
            "table": "other",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.551184000003559,
            "max_synchronous_ms": 0.513120000003255
          },
          {
            "fingerprint": "2bdd5b0dc86746fa5717badfc183547c4b5a5cdb1c80fc8967c0ae6949eec552",
            "operation": "select",
            "table": "other",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.2818780000015977,
            "max_synchronous_ms": 0.23480500000005122
          },
          {
            "fingerprint": "3b39801ac30e76669637eec0c4703945d3660e8fbdcbd0513cf8212f4e7dee8b",
            "operation": "select",
            "table": "audit_events",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.224887000003946,
            "max_synchronous_ms": 0.18235400000412483
          },
          {
            "fingerprint": "cca941246624cb77368f08ba1ee06b3c17ed154e680c0d32f0dc338985fd11c6",
            "operation": "select",
            "table": "other",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.18801099999109283,
            "max_synchronous_ms": 0.1192179999925429
          },
          {
            "fingerprint": "dbf053d65f68204ff835c1688fe3781e39964838f6ec2086bba8fb1b32435fd3",
            "operation": "select",
            "table": "skills",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.17055099999561207,
            "max_synchronous_ms": 0.10427199999685399
          },
          {
            "fingerprint": "0b12ca678fb24174c0acc4c7e06ec9c27d7db80c1512fb7bff72736a0b8ebe45",
            "operation": "select",
            "table": "skill_revisions",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.138704000004509,
            "max_synchronous_ms": 0.0815740000034566
          },
          {
            "fingerprint": "c08d0f81ef4e0697b510c883c287633b6857733e81ec6774e28a8d79778e9734",
            "operation": "insert",
            "table": "revision_readers",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.1053200000023935,
            "max_synchronous_ms": 0.059085000000777654
          },
          {
            "fingerprint": "e0b5c86f4de2f4b9e0afe979e5e59b5b0f9cd17919792e6d42ba8df40a7d6170",
            "operation": "update",
            "table": "tenants",
            "calls": 2,
            "errors": 0,
            "synchronous_ms": 0.09477399999741465,
            "max_synchronous_ms": 0.05000599999766564
          }
        ],
        "runtime": {
          "event_loop_delay": {
            "resolution_ms": 20,
            "mean_ms": 69.47997510479574,
            "p95_ms": 151.781375,
            "max_ms": 502.530047,
            "observations": 1126
          },
          "event_loop_utilization": 0.9999819855756844,
          "cpu_user_ms": 37415.836,
          "cpu_system_ms": 5290.964,
          "resource_usage_fs_write_delta": 1145152,
          "resource_usage_fs_read_delta": 104,
          "voluntary_context_switches": 137005,
          "involuntary_context_switches": 3587,
          "gc": {
            "count": 55,
            "duration_ms": 943.9899923801422,
            "max_duration_ms": 108.13086104393005
          }
        },
        "rss_bytes": 531333120,
        "heap_used_bytes": 147771448
      }
    ],
    "errors": 0,
    "requests": 6000,
    "status": "measured",
    "elapsed_ms": 78272.37055200001,
    "raw_samples_policy": "Per-minute exact quantiles; bounded minute buffer; no accumulated per-request heap."
  },
  "target_met": false
}
```

Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.

Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.

OS cache was not flushed; startup integrity scan warms files.

Soak katalog içindir; LLM, handoff, PostgreSQL yükü veya model kalitesi iddiası yoktur. Aynı host üzerindeki diğer işler sonuçları etkileyebilir.
