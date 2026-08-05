// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

export const COLLECTD_METRICS_SKILL: Skill = {
  id: "collectd-metrics",
  name: "Collectd metrics: topics, units, conversions, and plots",
  whenToUse:
    "When reading, plotting, or explaining collectd/* CPU, memory, load, disk, network, IRQ, process, or thermal metrics.",
  body: `# Collectd metrics

Use this reference whenever a request involves a \`collectd/*\` topic or asks to query, plot, or
interpret host CPU, memory, filesystem, disk, network, IRQ, process, load, or thermal data.

## Topic and message-path shape

Live topics use this exact form, without a leading slash:

\`\`\`text
collectd/<host>/<plugin>
\`\`\`

\`<host>\` is \`s100\` or \`x5\`. The \`AortaTopicPrefix\` is \`collectd/%h\`, where \`%h\` is
replaced by that hostname. A recording observed in production has the same nine plugin topics for
both hosts:

\`\`\`text
collectd/s100/{cpu,df,disk,interface,irq,load,memory,processes,soc_thermal}
collectd/x5/{cpu,df,disk,interface,irq,load,memory,processes,soc_thermal}
\`\`\`

Important naming differences:

- The source collector plugin is named \`tasks_cpu\`, but its live topic is
  \`collectd/<host>/processes\`. Never look for a \`collectd/<host>/tasks_cpu\` topic.
- \`perf_trigger\` is a cache-driven trigger and publishes no metric topic.
- \`vita_basic\` is currently not loaded, so its heartbeat is not expected in live recordings.

Every topic carries a \`CollectdMetric\` wrapper. Numeric plugin fields are below \`.payload\`;
\`.payload_type\` is the FlatBuffer union discriminator, not a metric to plot. Array-valued batches
use a stable identifier that can be selected with a message-path filter:

- core: \`collectd/s100/cpu.payload.cores[:]{core_id==0}.user\`
- mount: \`collectd/s100/df.payload.mounts[:]{mountpoint=="/"}.used\`
- device: \`collectd/s100/disk.payload.devices[:]{device=="mmcblk0"}.octets_read\`
- interface: \`collectd/s100/interface.payload.interfaces[:]{name=="eth0"}.rx_bytes\`
- IRQ: \`collectd/s100/irq.payload.irqs[:]{irq=="IPI0"}.count\`
- process: \`collectd/s100/processes.payload.tasks[:]{name=="cloud_agent"}.user\`
- thermal zone: \`collectd/s100/soc_thermal.payload.zones[:]{zone=="cpu_0"}.temperature\`

Inspect the loaded data catalog before choosing a filter value. Device names, IRQ names, process
names, thread names, and the number of cores or thermal zones are data-dependent.

## Metric dictionary

The “source” column describes collectd input. The “published” column is what the decoded
FlatBuffer field already contains. “Converted” means the collection side has already performed the
conversion; do not apply it again.

### CPU — \`collectd/<host>/cpu\`

All eight states are emitted separately for each core in \`payload.cores\`.

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`cpu-user\` | \`cores[:].user\` | user-space CPU | DERIVE jiffies → % (0–100) | yes, \`ValuesPercentage=true\` |
| \`cpu-system\` | \`cores[:].system\` | kernel CPU | DERIVE jiffies → % (0–100) | yes |
| \`cpu-idle\` | \`cores[:].idle\` | idle CPU | DERIVE jiffies → % (0–100) | yes |
| \`cpu-wait\` | \`cores[:].wait\` | I/O wait | DERIVE jiffies → % (0–100) | yes |
| \`cpu-nice\` | \`cores[:].nice\` | low-priority user CPU | DERIVE jiffies → % (0–100) | yes |
| \`cpu-softirq\` | \`cores[:].softirq\` | software interrupt CPU | DERIVE jiffies → % (0–100) | yes |
| \`cpu-interrupt\` | \`cores[:].interrupt\` | hardware interrupt CPU | DERIVE jiffies → % (0–100) | yes |
| \`cpu-steal\` | \`cores[:].steal\` | virtual-machine steal CPU | DERIVE jiffies → % (0–100) | yes |

These are per-core percentages. Do **not** divide them by the number of cores.

### Memory — \`collectd/<host>/memory\`

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`memory-used\` | \`payload.used\` | used memory | GAUGE bytes → bytes | no |
| \`memory-free\` | \`payload.free\` | free memory | GAUGE bytes → bytes | no |
| \`memory-buffered\` | \`payload.buffered\` | buffer memory | GAUGE bytes → bytes | no |
| \`memory-cached\` | \`payload.cached\` | cached memory | GAUGE bytes → bytes | no |
| \`memory-slab_recl\` | \`payload.slab_recl\` | reclaimable slab | GAUGE bytes → bytes | no |
| \`memory-slab_unrecl\` | \`payload.slab_unrecl\` | unreclaimable slab | GAUGE bytes → bytes | no |

Convert for presentation with \`MB = bytes / 1048576\` or \`GB = bytes / 1073741824\`.

### Load — \`collectd/<host>/load\`

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`load-shortterm\` | \`payload.shortterm\` | 1-minute load average | dimensionless GAUGE → dimensionless | no |
| \`load-midterm\` | \`payload.midterm\` | 5-minute load average | dimensionless GAUGE → dimensionless | no |
| \`load-longterm\` | \`payload.longterm\` | 15-minute load average | dimensionless GAUGE → dimensionless | no |

Load is not a percentage. Interpret it relative to the host's runnable CPU capacity.

### Filesystems — \`collectd/<host>/df\`

Rows live under \`payload.mounts\` and are keyed by \`mountpoint\`.

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`df_complex-used\` | \`mounts[:].used\` | used space | GAUGE bytes → uint64 bytes | no |
| \`df_complex-free\` | \`mounts[:].free\` | available space | GAUGE bytes → uint64 bytes | no |
| \`df_complex-reserved\` | \`mounts[:].reserved\` | reserved space | GAUGE bytes → uint64 bytes | no |
| \`df_inodes-used\` | \`mounts[:].inodes_used\` | used inodes | GAUGE count → uint64 count | no |
| \`df_inodes-free\` | \`mounts[:].inodes_free\` | free inodes | GAUGE count → uint64 count | no |
| \`df_inodes-reserved\` | \`mounts[:].inodes_reserved\` | reserved inodes | GAUGE count → uint64 count | no |

Space fields use the same MB/GB conversions as memory. Inode fields are counts and must not be
converted as bytes.

### Block devices — \`collectd/<host>/disk\`

Rows live under \`payload.devices\` and are keyed by \`device\`. The read/write source pairs expand
to separate FlatBuffer fields:

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`disk_octets (read)\` | \`devices[:].octets_read\` | read throughput | cumulative DERIVE bytes → bytes/s | yes, \`diff_rate\` |
| \`disk_octets (write)\` | \`devices[:].octets_write\` | write throughput | cumulative DERIVE bytes → bytes/s | yes, \`diff_rate\` |
| \`disk_ops (read)\` | \`devices[:].ops_read\` | read operations | cumulative DERIVE ops → ops/s | yes, \`diff_rate\` |
| \`disk_ops (write)\` | \`devices[:].ops_write\` | write operations | cumulative DERIVE ops → ops/s | yes, \`diff_rate\` |
| \`disk_time (read)\` | \`devices[:].time_read\` | read I/O time | cumulative DERIVE ms → ms/s | yes, \`diff_rate\` |
| \`disk_time (write)\` | \`devices[:].time_write\` | write I/O time | cumulative DERIVE ms → ms/s | yes, \`diff_rate\` |
| \`disk_merged (read)\` | \`devices[:].merged_read\` | merged read requests | cumulative DERIVE count → merged/s | yes, \`diff_rate\` |
| \`disk_merged (write)\` | \`devices[:].merged_write\` | merged write requests | cumulative DERIVE count → merged/s | yes, \`diff_rate\` |
| \`disk_io_time\` | \`devices[:].io_time\` | active I/O time | cumulative DERIVE ms → ms/s | yes, \`diff_rate\` |
| \`weighted_io_time\` | \`devices[:].weighted_io_time\` | weighted I/O time | cumulative DERIVE ms → ms/s | yes, \`diff_rate\` |
| \`pending_operations\` | \`devices[:].pending_ops\` | current queue depth | GAUGE count → int64 count | no |

### Network interfaces — \`collectd/<host>/interface\`

Rows live under \`payload.interfaces\` and are keyed by \`name\`.

| Reference group | Fields | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`if_octets (rx/tx)\` | \`rx_bytes\`, \`tx_bytes\` | received/transmitted throughput | cumulative DERIVE bytes → bytes/s | yes, \`diff_rate\` |
| \`if_packets (rx/tx)\` | \`rx_packets\`, \`tx_packets\` | packet rate | cumulative DERIVE packets → packets/s | yes, \`diff_rate\` |
| \`if_errors (rx/tx)\` | \`rx_errors\`, \`tx_errors\` | error rate | cumulative DERIVE errors → errors/s | yes, \`diff_rate\` |
| \`if_dropped (rx/tx)\` | \`rx_dropped\`, \`tx_dropped\` | drop rate | cumulative DERIVE drops → drops/s | yes, \`diff_rate\` |

Convert only byte rates to network megabits with
\`Mbps = bytes_per_sec × 8 / 1000000\`. Packet, error, and drop rates remain counts per second.

### IRQ — \`collectd/<host>/irq\`

\`irq-<name>\` is emitted as one \`payload.irqs\` row per IRQ name. The \`count\` field is cumulative
DERIVE events converted by \`diff_rate\` to events/s. Select a row with
\`payload.irqs[:]{irq=="<name>"}.count\`.

### Processes and threads — \`collectd/<host>/processes\`

The source plugin is \`tasks_cpu\`; the live topic name is \`processes\`. Rows live under
\`payload.tasks\` and are keyed by process \`name\`.

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`proc_cpu (user)\` | \`tasks[:].user\` | aggregate process user CPU | jiffy delta → CPU cores (float, 0–N) | yes |
| \`proc_cpu (syst)\` | \`tasks[:].syst\` | aggregate process kernel CPU | jiffy delta → CPU cores (float, 0–N) | yes |
| \`ps_rss\` | \`tasks[:].rss_bytes\` | process resident memory | RSS pages → kB | yes |
| \`proc_cpu (thread, user)\` | \`tasks[:].threads[:].user\` | thread user CPU | jiffy delta → CPU cores (float, 0–N) | yes |
| \`proc_cpu (thread, syst)\` | \`tasks[:].threads[:].syst\` | thread kernel CPU | jiffy delta → CPU cores (float, 0–N) | yes |

\`proc_cpu\` is measured in **CPU cores**, not percent, and may exceed \`1.0\`. Aggregate process
values use:

\`\`\`text
user = (utime_new - utime_old) / timediff_seconds
syst = (stime_new - stime_old) / timediff_seconds
\`\`\`

Only processes or threads whose \`user + syst > 2.0\` are reported. Thread rows are limited to
runnable or uninterruptible-sleep (\`R\`/\`D\`) threads and are keyed by \`tid_name\`, for example:
\`payload.tasks[:]{name=="cloud_agent"}.threads[:]{tid_name=="12345_DDS"}.user\`.

The FlatBuffer field is named \`rss_bytes\`, but the authoritative exported value is **kB**, computed
as \`rss_pages × (getpagesize() / 1024)\`; ARM64 commonly uses 4096-byte pages, so the numeric result
is \`rss_pages × 4\`. Do not divide this field by 1048576 as if it were bytes; divide kB by 1024 for
MB.

### SoC thermal — \`collectd/<host>/soc_thermal\`

| Reference metric | Field | Meaning | Source → published | Converted? |
| --- | --- | --- | --- | --- |
| \`temperature-cpu_<n>\` | \`zones[:]{zone=="cpu_<n>"}.temperature\` | CPU zone temperature | parsed GAUGE °C → °C | already °C |
| \`temperature-mcu_<n>\` | \`zones[:]{zone=="mcu_<n>"}.temperature\` | MCU zone temperature | parsed GAUGE °C → °C | already °C |
| \`temperature-bpu_<n>\` | \`zones[:]{zone=="bpu_<n>"}.temperature\` | BPU zone temperature | parsed GAUGE °C → °C | already °C |
| \`percent-bpu_0\` | \`bpu_usage[:]{name=="bpu_0"}.usage\` | BPU utilization | parsed GAUGE % → % (0–100) | already percent |

S100 has MCU temperature zones; X5 does not. Both can expose CPU and BPU temperatures.
\`percent-bpu_0\` is utilization, not temperature, so do not plot it on a °C axis.

### Non-metric plugins

- \`perf_trigger\`: no metric output. It reads cached CPU/process values, computes
  \`busy = 100 - cpu-idle\` and \`proc = user + syst\`, and may trigger a \`ProfileSnapshot\`.
- \`vita_basic\`: defines \`gauge-heartbeat = 1.0\`, but it is currently commented out/not loaded.
  Do not expect a live \`collectd/<host>/vita_basic\` topic.

## Conversion rules and missing points

1. **CPU is already a percentage.** With \`ValuesPercentage=true\`, collectd converts jiffy deltas
   internally and reports every core separately in the 0–100 range. Never divide by core count and
   never apply \`diff_rate\` to these fields.
2. **DERIVE counters are already rates.** Disk, interface, and IRQ use:
   \`diff_rate = (current - previous) × 1e9 / (current_time_ns - previous_time_ns)\`.
   The first sample has no previous counter and is \`NaN\`; a counter wrap or decrease is also
   \`NaN\`. A Plot should therefore tolerate an empty point at startup or after a reset.
3. **Memory and filesystem space remain bytes.** Convert display units explicitly:
   \`MB = bytes / 1048576\`, \`GB = bytes / 1073741824\`.
4. **Network byte rates become Mbps only in the presentation layer:**
   \`Mbps = bytes_per_sec × 8 / 1000000\`.
5. **Process CPU is cores.** A value of \`2.4\` means 2.4 cores, not 2.4%. Do not clamp it to 1 or
   100. Process RSS is kB despite the decoded field name \`rss_bytes\`.
6. **Thermal fields need no unit conversion.** Temperatures are °C and BPU usage is 0–100%.

## Plot recipes

Every Plot path needs \`"enabled": true\` and a \`timestampMethod\`. Replace host names and array
filter values only with values present in the loaded catalog.

### Per-core CPU comparison

\`\`\`json
{
  "paths": [
    { "value": "collectd/s100/cpu.payload.cores[:]{core_id==0}.user", "enabled": true, "timestampMethod": "receiveTime", "label": "core 0 user %" },
    { "value": "collectd/s100/cpu.payload.cores[:]{core_id==1}.user", "enabled": true, "timestampMethod": "receiveTime", "label": "core 1 user %" }
  ],
  "minYValue": 0,
  "maxYValue": 100,
  "yAxisLabel": "CPU (%)"
}
\`\`\`

Use 0–100 bounds for CPU and BPU percentages. Add \`system\`, \`wait\`, or \`idle\` paths when those
states answer the question; do not sum unrelated cores into one percentage.

### Memory used/free

\`\`\`json
{
  "paths": [
    { "value": "collectd/s100/memory.payload.used", "enabled": true, "timestampMethod": "receiveTime", "label": "used bytes" },
    { "value": "collectd/s100/memory.payload.free", "enabled": true, "timestampMethod": "receiveTime", "label": "free bytes" }
  ],
  "yAxisLabel": "bytes"
}
\`\`\`

The built-in Plot draws separate lines and has no true stacked-series option. If the user asks for
a stacked memory view, do not invent a \`stack\` config key: keep the two synchronized series
together, or derive converted/stackable series with an available transformation tool. Label raw
paths as bytes unless a real conversion has been applied.

### Disk and network rates

\`\`\`json
{
  "paths": [
    { "value": "collectd/s100/disk.payload.devices[:]{device==\\"mmcblk0\\"}.octets_read", "enabled": true, "timestampMethod": "receiveTime", "label": "disk read bytes/s" },
    { "value": "collectd/s100/disk.payload.devices[:]{device==\\"mmcblk0\\"}.octets_write", "enabled": true, "timestampMethod": "receiveTime", "label": "disk write bytes/s" },
    { "value": "collectd/s100/interface.payload.interfaces[:]{name==\\"eth0\\"}.rx_bytes", "enabled": true, "timestampMethod": "receiveTime", "label": "eth0 RX bytes/s" },
    { "value": "collectd/s100/interface.payload.interfaces[:]{name==\\"eth0\\"}.tx_bytes", "enabled": true, "timestampMethod": "receiveTime", "label": "eth0 TX bytes/s" }
  ],
  "yAxisLabel": "bytes/s"
}
\`\`\`

These fields are already per-second rates. Do not differentiate them again. Convert all four to
Mbps before relabeling the axis as Mbps.

### Thermal curves

\`\`\`json
{
  "paths": [
    { "value": "collectd/s100/soc_thermal.payload.zones[:]{zone==\\"cpu_0\\"}.temperature", "enabled": true, "timestampMethod": "receiveTime", "label": "CPU 0 °C" },
    { "value": "collectd/s100/soc_thermal.payload.zones[:]{zone==\\"mcu_0\\"}.temperature", "enabled": true, "timestampMethod": "receiveTime", "label": "MCU 0 °C" },
    { "value": "collectd/s100/soc_thermal.payload.zones[:]{zone==\\"bpu_0\\"}.temperature", "enabled": true, "timestampMethod": "receiveTime", "label": "BPU 0 °C" }
  ],
  "yAxisLabel": "temperature (°C)"
}
\`\`\`

Omit MCU paths for X5. Plot \`bpu_usage[:].usage\` in a separate 0–100% panel. Never combine
percentages, temperatures, byte counts, and rates on the same y-axis. Keep different rate units
(\`bytes/s\`, \`ops/s\`, \`events/s\`, \`ms/s\`) separate unless they have been normalized.

## Collection behavior

The main cadence is \`Interval=2s\`, so normal samples are two seconds apart. A gap is not
automatically zero: it may be a missing batch, a \`NaN\` first-rate sample, a reset, or absent
high-CPU process output.

### Runtime, batching, files, and transport

| Setting | Value | Effect |
| --- | --- | --- |
| \`Interval\` | 2s | global sample interval |
| \`Timeout\` | 2s | read timeout |
| \`ReadThreads\` | 5 | collector read threads |
| \`MaxBatchAgeMs\` | 5000 | maximum batch wait |
| \`MaxFileSeconds\` | 1800 | MCAP rotation interval |
| \`MaxFileMB\` | 64 | MCAP rotation size |
| \`MaxFiles\` | 2 | maximum retained MCAP files |
| \`Compression\` | zstd | MCAP compression |
| \`ChunkSizeKB\` | 768 | MCAP chunk size |
| \`PublishAorta\` | true | publish flushed batches to Aorta |
| \`AortaTopicPrefix\` | \`collectd/%h\` | host-qualified topic prefix |

### Plugin-specific collection

| Setting | Value | Interpretation |
| --- | --- | --- |
| \`CPU ReportByCpu\` | true | one row per core |
| \`CPU ValuesPercentage\` | true | direct 0–100 percentages |
| \`df MountPoints\` | \`/\`, \`/log\`, \`/userdata\`, \`/ota\`, \`/app_param\` | only these mountpoints |
| \`df ValuesAbsolute\` | true | absolute byte/count values are collected |
| \`df ValuesPercentage\` | true | collectd also computes percentage values |
| \`disk IgnoreSelected\` | true for \`dm-*\` | device-mapper devices are excluded |
| \`interface\` | \`eth0\`, \`wlan0\` | only these interfaces are monitored |
| \`tasks_cpu EnableProcess\` | true | process-level sampling enabled |
| \`tasks_cpu EnableThread\` | true | thread-level sampling enabled |
| \`tasks_cpu report threshold\` | \`user+syst > 2.0\` | low-CPU tasks are absent, not zero |

### Performance-trigger behavior

| Setting | Value |
| --- | --- |
| \`perf_trigger CoreThreshold\` | 95% |
| \`perf_trigger ProcessThreshold\` | 95% |
| \`perf_trigger Sustain\` | 3 consecutive over-threshold checks |
| \`perf_trigger CooldownSec\` | 300s |
| \`perf_trigger StartupDelaySec\` | 60s |

When enabled, \`perf_trigger\` reads CPU and process values from the collectd value cache. Three
consecutive observations above the configured 95% threshold can create a \`ProfileSnapshot\`;
the first 60 seconds are suppressed and another trigger is suppressed for 300 seconds. This is why
ProfileSnapshot data may appear only around sustained hot periods and not at every individual CPU
spike. The trigger itself still has no collectd metric topic.

## Interpretation checklist

1. Confirm the exact host and plugin topic from the loaded catalog.
2. Use \`.payload\` and filter array rows by their real identifier.
3. State the stored unit before interpreting a number.
4. Apply only presentation conversions; never repeat collection-side conversions.
5. Expect two-second cadence, startup/reset \`NaN\` rate gaps, and threshold-filtered processes.
6. Keep incompatible units on separate axes and explain any missing S100/X5-specific metric.
`,
};
