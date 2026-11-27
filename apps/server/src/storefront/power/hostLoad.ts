// Storefront Code (fork): whether this host is quiet enough for Sleep when done to suspend it
// (fork/design/F8-sleep-and-wake.md). Linux only, from /proc and /sys: other platforms count as quiet.
import type { StorefrontPowerBusy } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** How long the host must have been quiet, and how often it is measured meanwhile. */
export const QUIET_WINDOW_MS = 5 * 60_000;
export const SAMPLE_EVERY_MS = 30_000;

// Above any of these, averaged over the window, the host is busy. One process counts with the
// children it reaped, so a script running many short commands is seen as well as one long job.
const PROCESS_CORES = 0.5;
const TOTAL_CORES = 2;
const NETWORK_BYTES_PER_SECOND = 1024 * 1024;
const DISK_BYTES_PER_SECOND = 32 * 1024 * 1024;

// USER_HZ: the unit of /proc/<pid>/stat times, 100 on every Linux architecture (a fixed ABI).
const TICKS_PER_SECOND = 100;
const SECTOR_BYTES = 512;
const WHOLE_DISK = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/;

export interface LoadSample {
  readonly at: number;
  readonly cores: number;
  readonly cpuBusy: number;
  readonly cpuTotal: number;
  readonly networkBytes: number;
  readonly diskBytes: number;
  /** CPU ticks per process (its own and its reaped children's), keyed `pid:starttime`. */
  readonly processes: ReadonlyMap<string, { readonly name: string; readonly ticks: number }>;
}

export function parseCpuStat(text: string) {
  const lines = text.split("\n");
  const fields = (lines.find((line) => line.startsWith("cpu ")) ?? "").split(/\s+/).slice(1);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map(Number);
  const busy = [user, nice, system, irq, softirq, steal].reduce<number>((a, b) => a + (b ?? 0), 0);
  return {
    cores: lines.filter((line) => /^cpu\d+ /.test(line)).length,
    cpuBusy: busy,
    cpuTotal: busy + (idle ?? 0) + (iowait ?? 0),
  };
}

/** Bytes received and sent on the given interfaces. */
export function parseNetDev(text: string, interfaces: ReadonlySet<string>): number {
  let bytes = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0 || !interfaces.has(line.slice(0, colon).trim())) continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    bytes += (fields[0] ?? 0) + (fields[8] ?? 0);
  }
  return bytes;
}

/** Bytes read and written on whole disks (not their partitions, device mapper or zram). */
export function parseDiskStats(text: string): number {
  let sectors = 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!WHOLE_DISK.test(fields[2] ?? "")) continue;
    sectors += Number(fields[5] ?? 0) + Number(fields[9] ?? 0);
  }
  return sectors * SECTOR_BYTES;
}

/** `/proc/<pid>/stat`: the name may hold spaces and parentheses, so fields count from the last ")". */
export function parseProcessStat(pid: string, text: string) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const ticks = [11, 12, 13, 14].reduce((total, index) => total + Number(fields[index] ?? 0), 0);
  if (!Number.isFinite(ticks)) return null;
  return { key: `${pid}:${fields[19]}`, name: text.slice(open + 1, close), ticks };
}

/** What kept the host busy between two samples, the most telling first; null when it was quiet. */
export function busyBetween(from: LoadSample, to: LoadSample): StorefrontPowerBusy | null {
  const seconds = (to.at - from.at) / 1000;
  if (seconds <= 0) return null;
  let busiest: { readonly name: string; readonly cores: number } | null = null;
  for (const [key, process] of to.processes) {
    const cores =
      (process.ticks - (from.processes.get(key)?.ticks ?? 0)) / TICKS_PER_SECOND / seconds;
    if (cores >= PROCESS_CORES && cores > (busiest?.cores ?? 0))
      busiest = { name: process.name, cores };
  }
  if (busiest) return { kind: "process", name: busiest.name, cores: busiest.cores };
  const total = to.cpuTotal - from.cpuTotal;
  const cores = total > 0 ? ((to.cpuBusy - from.cpuBusy) / total) * to.cores : 0;
  if (cores >= TOTAL_CORES) return { kind: "cpu", cores };
  const disk = (to.diskBytes - from.diskBytes) / seconds;
  if (disk >= DISK_BYTES_PER_SECOND) return { kind: "disk", bytesPerSecond: disk };
  const network = (to.networkBytes - from.networkBytes) / seconds;
  if (network >= NETWORK_BYTES_PER_SECOND) return { kind: "network", bytesPerSecond: network };
  return null;
}

/** One measurement of this Linux host; files that vanish meanwhile (an exited process) are skipped. */
export const sampleLinuxLoad = Effect.fn("HostPower.sampleLoad")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const read = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  const list = (path: string) =>
    fs.readDirectory(path).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  // Physical interfaces only: bridges, veths and tailscale0 would count the same bytes again.
  const physical = new Set<string>();
  for (const name of yield* list("/sys/class/net")) {
    if (yield* fs.exists(`/sys/class/net/${name}/device`).pipe(Effect.orElseSucceed(() => false))) {
      physical.add(name);
    }
  }
  const pids = (yield* list("/proc")).filter((name) => /^\d+$/.test(name));
  const stats = yield* Effect.forEach(
    pids,
    (pid) => read(`/proc/${pid}/stat`).pipe(Effect.map((text) => parseProcessStat(pid, text))),
    { concurrency: 32 },
  );
  const processes = new Map<string, { readonly name: string; readonly ticks: number }>();
  for (const stat of stats)
    if (stat) processes.set(stat.key, { name: stat.name, ticks: stat.ticks });
  return {
    at: yield* Clock.currentTimeMillis,
    ...parseCpuStat(yield* read("/proc/stat")),
    networkBytes: parseNetDev(yield* read("/proc/net/dev"), physical),
    diskBytes: parseDiskStats(yield* read("/proc/diskstats")),
    processes,
  } satisfies LoadSample;
});
