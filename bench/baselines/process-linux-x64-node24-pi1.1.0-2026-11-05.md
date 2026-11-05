# Repeated process benchmark: complete

Run: ff496120-b7a9-4021-b03d-5562545bcfb7 · 2026-11-05T21:57:45.283Z
Source: 92ff64643f2ba2cf4540cafb0c9246880e8e0a2b (clean)
Environment: linux/x64, Node v24.19.0, Pi 1.1.0; host node, backend process, provider loopback, mode lean.

Advisory process evidence; timing and memory changes never fail this command. Execution failures and incomplete measurements do. Each scenario/repetition uses a fresh Node host with host warm-up and fresh agent Pi processes. RSS is each child process's sampled peak, not concurrent total or private memory. peakRssMB/cpuMs cover only the host. All raw trials are retained; no fastest-run selection. Medians summarize repetitions, not a confidence bound.

| Scenario | Metric                     | Repeated samples                                 | Median   | Max      |
| -------- | -------------------------- | ------------------------------------------------ | -------- | -------- |
| fanout-1 | spawnMs.p50                | 449.268, 473.723, 464.857, 479.656, 457.811      | 464.857  | 479.656  |
| fanout-1 | spawnMs.p95                | 449.268, 473.723, 464.857, 479.656, 457.811      | 464.857  | 479.656  |
| fanout-1 | process.startupMs.p50      | 446.397, 470.687, 461.64, 476.053, 454.528       | 461.64   | 476.053  |
| fanout-1 | process.startupMs.p95      | 446.397, 470.687, 461.64, 476.053, 454.528       | 461.64   | 476.053  |
| fanout-1 | memoryPerAgentMB           | 143.8, 143.3, 141.8, 142, 143.5                  | 143.3    | 143.8    |
| fanout-1 | process.childPeakRssMB.p95 | 143.8, 143.3, 141.8, 142, 143.5                  | 143.3    | 143.8    |
| fanout-1 | peakRssMB                  | 168.32, 172.32, 170.63, 172.95, 172.15           | 172.15   | 172.95   |
| fanout-1 | cpuMs                      | 42, 47, 44, 45, 38                               | 44       | 47       |
| fanout-1 | wallMs                     | 761, 793, 780, 791, 773                          | 780      | 793      |
| fanout-8 | spawnMs.p50                | 1248.659, 1334.068, 1301.748, 1267.815, 1265.869 | 1267.815 | 1334.068 |
| fanout-8 | spawnMs.p95                | 1396.761, 1471.092, 1362.093, 1367.066, 1436.848 | 1396.761 | 1471.092 |
| fanout-8 | process.startupMs.p50      | 1242.761, 1324.741, 1295.797, 1241.126, 1259.917 | 1259.917 | 1324.741 |
| fanout-8 | process.startupMs.p95      | 1380.745, 1466.313, 1322.173, 1352.776, 1413.075 | 1380.745 | 1466.313 |
| fanout-8 | memoryPerAgentMB           | 136.03, 136.88, 133.43, 134.96, 135.59           | 135.59   | 136.88   |
| fanout-8 | process.childPeakRssMB.p95 | 137.6, 142.4, 135.2, 136.8, 138.6                | 137.6    | 142.4    |
| fanout-8 | peakRssMB                  | 170.32, 172.46, 170.19, 172.48, 180.05           | 172.46   | 180.05   |
| fanout-8 | cpuMs                      | 244, 324, 308, 306, 186                          | 306      | 324      |
| fanout-8 | wallMs                     | 1721, 1819, 1701, 1729, 1772                     | 1729     | 1819     |
| chain    | spawnMs.p50                | 476.687, 472.862, 469.433, 461.493, 468.975      | 469.433  | 476.687  |
| chain    | spawnMs.p95                | 487.197, 521.557, 483.297, 502.639, 518.847      | 502.639  | 521.557  |
| chain    | process.startupMs.p50      | 464.69, 468.85, 462.13, 458.995, 465.313         | 464.69   | 468.85   |
| chain    | process.startupMs.p95      | 473.734, 498.87, 480.813, 481.657, 503.397       | 481.657  | 503.397  |
| chain    | memoryPerAgentMB           | 143.07, 142.45, 143.43, 142.8, 142.43            | 142.8    | 143.43   |
| chain    | process.childPeakRssMB.p95 | 143.5, 143.5, 147.2, 143.9, 143.6                | 143.6    | 147.2    |
| chain    | peakRssMB                  | 169.98, 171.2, 172.21, 171.43, 172.22            | 171.43   | 172.22   |
| chain    | cpuMs                      | 154, 163, 157, 155, 160                          | 157      | 163      |
| chain    | wallMs                     | 2719, 2788, 2705, 2723, 2779                     | 2723     | 2788     |
| builder  | spawnMs.p50                | 483.134, 498.184, 479.935, 476.235, 481.727      | 481.727  | 498.184  |
| builder  | spawnMs.p95                | 483.568, 527.836, 524.806, 484.574, 494.939      | 494.939  | 527.836  |
| builder  | process.startupMs.p50      | 462.432, 473.498, 460.893, 460.772, 456.446      | 460.893  | 473.498  |
| builder  | process.startupMs.p95      | 468.111, 502.281, 499.835, 461.18, 474.072       | 474.072  | 502.281  |
| builder  | memoryPerAgentMB           | 141.05, 142.3, 141.75, 141.6, 142.7              | 141.75   | 142.7    |
| builder  | process.childPeakRssMB.p95 | 142.6, 143.5, 142.5, 143.7, 143.9                | 143.5    | 143.9    |
| builder  | peakRssMB                  | 171.7, 171.48, 171.59, 170.42, 165.97            | 171.48   | 171.7    |
| builder  | cpuMs                      | 96, 136, 105, 106, 105                           | 105      | 136      |
| builder  | wallMs                     | 1448, 1526, 1486, 1464, 1478                     | 1478     | 1526     |

Raw measurements, attempts, validation, and full provenance are in the companion JSON report.

Baseline comparison: not-requested.
