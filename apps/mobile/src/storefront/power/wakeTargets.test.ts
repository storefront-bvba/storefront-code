import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hostsToWake } from "./wakeTargets";

const omarchy = EnvironmentId.make("env-omarchy");
const macbook = EnvironmentId.make("env-macbook");

describe("hostsToWake", () => {
  it("names each host with a queued message and no connection, once", () => {
    const queues = {
      a: [{ environmentId: omarchy }, { environmentId: omarchy }],
      b: [{ environmentId: macbook }],
    };
    expect(hostsToWake(queues, (id) => id === macbook)).toEqual([omarchy]);
  });

  it("wakes nothing when nothing waits or every host is connected", () => {
    expect(hostsToWake({}, () => false)).toEqual([]);
    expect(hostsToWake({ a: [{ environmentId: omarchy }] }, () => true)).toEqual([]);
  });
});
