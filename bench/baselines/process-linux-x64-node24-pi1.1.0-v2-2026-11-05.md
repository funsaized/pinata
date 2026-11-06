# Repeated process benchmark: complete

Run: ba6d4cb3-d2ab-4bee-b197-dd9e755370c7 · 2026-11-05T22:21:46.220Z
Source: f7402f948e532800128925492958e789befd99db (clean)
Environment: linux/x64, Node v24.19.0, Pi 1.1.0; host node, backend process, provider loopback, mode lean.

Advisory process evidence; timing and memory changes never fail this command. Execution failures and incomplete measurements do. Each scenario/repetition uses a fresh Node host with host warm-up and fresh agent Pi processes. RSS is each child process's sampled peak, not concurrent total or private memory. peakRssMB/cpuMs cover only the host. All raw trials are retained; no fastest-run selection. Medians summarize repetitions, not a confidence bound.

| Scenario | Metric                     | Repeated samples                                 | Median   | Max      |
| -------- | -------------------------- | ------------------------------------------------ | -------- | -------- |
| fanout-1 | spawnMs.p50                | 464.405, 467.54, 494.182, 482.36, 457.658        | 467.54   | 494.182  |
| fanout-1 | spawnMs.p95                | 464.405, 467.54, 494.182, 482.36, 457.658        | 467.54   | 494.182  |
| fanout-1 | process.startupMs.p50      | 461.49, 464.144, 491.32, 479.065, 454.49         | 464.144  | 491.32   |
| fanout-1 | process.startupMs.p95      | 461.49, 464.144, 491.32, 479.065, 454.49         | 464.144  | 491.32   |
| fanout-1 | memoryPerAgentMB           | 143.7, 143, 141.4, 143.3, 143.6                  | 143.3    | 143.7    |
| fanout-1 | process.childPeakRssMB.p95 | 143.7, 143, 141.4, 143.3, 143.6                  | 143.3    | 143.7    |
| fanout-1 | peakRssMB                  | 167.56, 171.68, 168.51, 172.54, 169.52           | 169.52   | 172.54   |
| fanout-1 | cpuMs                      | 47, 42, 47, 46, 46                               | 46       | 47       |
| fanout-1 | wallMs                     | 787, 782, 808, 803, 773                          | 787      | 808      |
| fanout-8 | spawnMs.p50                | 1328.741, 1506.153, 1312.263, 1275.831, 1220.634 | 1312.263 | 1506.153 |
| fanout-8 | spawnMs.p95                | 1491.511, 1574.215, 1440.946, 1527.675, 1388.404 | 1491.511 | 1574.215 |
| fanout-8 | process.startupMs.p50      | 1300.469, 1498.423, 1303.18, 1269.416, 1206.178  | 1300.469 | 1498.423 |
| fanout-8 | process.startupMs.p95      | 1482.894, 1563.504, 1411.793, 1518.548, 1357.935 | 1482.894 | 1563.504 |
| fanout-8 | memoryPerAgentMB           | 135.86, 133.66, 136.13, 137.2, 135.8             | 135.86   | 137.2    |
| fanout-8 | process.childPeakRssMB.p95 | 138.9, 136, 137.9, 139.4, 139.5                  | 138.9    | 139.5    |
| fanout-8 | peakRssMB                  | 168.82, 172.66, 172.14, 173.27, 174.53           | 172.66   | 174.53   |
| fanout-8 | cpuMs                      | 320, 296, 300, 274, 256                          | 296      | 320      |
| fanout-8 | wallMs                     | 1846, 1913, 1803, 1874, 1743                     | 1846     | 1913     |
| chain    | spawnMs.p50                | 484.921, 476.102, 458.737, 500.487, 493.06       | 484.921  | 500.487  |
| chain    | spawnMs.p95                | 519.374, 477.424, 500.933, 508.366, 503.99       | 503.99   | 519.374  |
| chain    | process.startupMs.p50      | 470.318, 458.52, 455.819, 483.954, 473.173       | 470.318  | 483.954  |
| chain    | process.startupMs.p95      | 491.806, 473.292, 485.021, 499.329, 489.874      | 489.874  | 499.329  |
| chain    | memoryPerAgentMB           | 142.8, 142.38, 143.08, 141.03, 143.02            | 142.8    | 143.08   |
| chain    | process.childPeakRssMB.p95 | 143.9, 143.5, 144.4, 142.7, 144.5                | 143.9    | 144.5    |
| chain    | peakRssMB                  | 171.45, 201.83, 173, 172.47, 172.88              | 172.88   | 201.83   |
| chain    | cpuMs                      | 163, 156, 150, 170, 163                          | 163      | 170      |
| chain    | wallMs                     | 2794, 2707, 2702, 2824, 2809                     | 2794     | 2824     |
| builder  | spawnMs.p50                | 470.39, 486.134, 478.375, 490.383, 468.505       | 478.375  | 490.383  |
| builder  | spawnMs.p95                | 497.245, 486.976, 479.602, 514.716, 518.194      | 497.245  | 518.194  |
| builder  | process.startupMs.p50      | 455.388, 464.663, 457.431, 475.388, 453.487      | 457.431  | 475.388  |
| builder  | process.startupMs.p95      | 475.049, 472.046, 458.218, 493.019, 489.492      | 475.049  | 493.019  |
| builder  | memoryPerAgentMB           | 141.65, 140.65, 142.3, 141.6, 142.4              | 141.65   | 142.4    |
| builder  | process.childPeakRssMB.p95 | 143.4, 142.3, 143.1, 144.1, 142.8                | 143.1    | 144.1    |
| builder  | peakRssMB                  | 172.27, 171.95, 171.78, 172.13, 169.46           | 171.95   | 172.27   |
| builder  | cpuMs                      | 98, 97, 98, 101, 96                              | 98       | 101      |
| builder  | wallMs                     | 1451, 1454, 1439, 1484, 1460                     | 1454     | 1484     |

Raw measurements, attempts, validation, and full provenance are in the companion JSON report.

Baseline comparison: not-requested.
