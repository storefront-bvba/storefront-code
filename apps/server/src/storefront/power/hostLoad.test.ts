import { describe, expect, it } from "vite-plus/test";

import {
  busyBetween,
  type LoadSample,
  parseCpuStat,
  parseDiskStats,
  parseNetDev,
  parseProcessStat,
} from "./hostLoad.ts";

const sample = (at: number, overrides: Partial<LoadSample> = {}): LoadSample => ({
  at,
  cores: 24,
  cpuBusy: 0,
  cpuTotal: 0,
  networkBytes: 0,
  diskBytes: 0,
  processes: new Map(),
  ...overrides,
});
const MINUTE = 60_000;

describe("reading /proc", () => {
  it("adds up busy and total CPU time and counts the cores", () => {
    const stat = [
      "cpu  100 5 50 1000 20 3 2 0 0 0",
      "cpu0 50 2 25 500 10 1 1 0 0 0",
      "cpu1 50 3 25 500 10 2 1 0 0 0",
      "intr 12345",
    ].join("\n");
    expect(parseCpuStat(stat)).toEqual({ cores: 2, cpuBusy: 160, cpuTotal: 1180 });
  });

  it("counts only the given interfaces in /proc/net/dev", () => {
    const netDev = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets",
      "    lo: 9000 10 0 0 0 0 0 0 9000 10 0 0 0 0 0 0",
      "enp8s0: 1000 10 0 0 0 0 0 0 500 5 0 0 0 0 0 0",
      "docker0: 7000 10 0 0 0 0 0 0 7000 5 0 0 0 0 0 0",
    ].join("\n");
    expect(parseNetDev(netDev, new Set(["enp8s0"]))).toBe(1500);
  });

  it("counts whole disks, not partitions, device mapper or zram", () => {
    const diskStats = [
      " 259       0 nvme0n1 10 0 100 0 10 0 300 0 0 0 0",
      " 259       1 nvme0n1p1 10 0 100 0 10 0 300 0 0 0 0",
      " 253       0 dm-0 10 0 100 0 10 0 300 0 0 0 0",
      " 252       0 zram0 10 0 100 0 10 0 300 0 0 0 0",
      "   8       0 sda 1 0 2 0 1 0 2 0 0 0 0",
    ].join("\n");
    expect(parseDiskStats(diskStats)).toBe((400 + 4) * 512);
  });

  it("reads a process's times, with its reaped children, past a name with spaces", () => {
    const fields = "S 1 1 1 0 -1 0 0 0 0 0 120 30 400 50 20 0 8 0 98765 0";
    expect(parseProcessStat("42", `42 (Web Content (x)) ${fields}`)).toEqual({
      key: "42:98765",
      name: "Web Content (x)",
      ticks: 600,
    });
    expect(parseProcessStat("43", "")).toBeNull();
  });
});

describe("busyBetween", () => {
  it("is quiet below every threshold", () => {
    const from = sample(0, { processes: new Map([["1:1", { name: "chrome", ticks: 0 }]]) });
    const to = sample(5 * MINUTE, {
      cpuBusy: 100,
      cpuTotal: 2400,
      networkBytes: 100 * 1024 * 300,
      diskBytes: 10 * 1024 * 1024 * 300,
      processes: new Map([["1:1", { name: "chrome", ticks: 0.2 * 100 * 300 }]]),
    });
    expect(busyBetween(from, to)).toBeNull();
  });

  it("names a single process on one core among many idle ones", () => {
    const to = sample(5 * MINUTE, {
      cpuBusy: 100,
      cpuTotal: 2400,
      processes: new Map([["7:9", { name: "php", ticks: 100 * 300 }]]),
    });
    expect(busyBetween(sample(0), to)).toEqual({ kind: "process", name: "php", cores: 1 });
  });

  it("sees many short processes through the CPU total, then disks, then the network", () => {
    const cpu = sample(5 * MINUTE, { cpuBusy: 300, cpuTotal: 2400 });
    expect(busyBetween(sample(0), cpu)).toEqual({ kind: "cpu", cores: 3 });
    const disk = sample(5 * MINUTE, { diskBytes: 64 * 1024 * 1024 * 300 });
    expect(busyBetween(sample(0), disk)).toMatchObject({ kind: "disk" });
    const network = sample(5 * MINUTE, { networkBytes: 2 * 1024 * 1024 * 300 });
    expect(busyBetween(sample(0), network)).toMatchObject({ kind: "network" });
  });

  it("does not count a process that started meanwhile from zero twice", () => {
    const from = sample(0, { processes: new Map([["7:1", { name: "php", ticks: 50_000 }]]) });
    const to = sample(5 * MINUTE, {
      processes: new Map([["7:2", { name: "sh", ticks: 10 }]]),
    });
    expect(busyBetween(from, to)).toBeNull();
  });
});
