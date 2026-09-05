import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";

/** Bounded per-window diagnostics; no per-request or per-GC history retained. */
export function runtimeSampler() {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let gcCount = 0,
    gcDuration = 0,
    gcMax = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcDuration += entry.duration;
      gcMax = Math.max(gcMax, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  delay.enable();
  let cpu = process.cpuUsage(),
    resources = process.resourceUsage();
  let utilization = performance.eventLoopUtilization();
  return {
    sample() {
      const nextCpu = process.cpuUsage(),
        nextResources = process.resourceUsage();
      const nextUtilization = performance.eventLoopUtilization();
      const elu = performance.eventLoopUtilization(
        nextUtilization,
        utilization,
      );
      const result = {
        event_loop_delay: {
          resolution_ms: 20,
          mean_ms: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null,
          p95_ms: delay.count ? delay.percentile(95) / 1e6 : null,
          max_ms: delay.count ? delay.max / 1e6 : null,
          observations: delay.count,
        },
        event_loop_utilization: elu.utilization,
        cpu_user_ms: (nextCpu.user - cpu.user) / 1000,
        cpu_system_ms: (nextCpu.system - cpu.system) / 1000,
        resource_usage_fs_write_delta:
          nextResources.fsWrite - resources.fsWrite,
        resource_usage_fs_read_delta: nextResources.fsRead - resources.fsRead,
        voluntary_context_switches:
          nextResources.voluntaryContextSwitches -
          resources.voluntaryContextSwitches,
        involuntary_context_switches:
          nextResources.involuntaryContextSwitches -
          resources.involuntaryContextSwitches,
        gc: { count: gcCount, duration_ms: gcDuration, max_duration_ms: gcMax },
      };
      cpu = nextCpu;
      resources = nextResources;
      utilization = nextUtilization;
      gcCount = 0;
      gcDuration = 0;
      gcMax = 0;
      delay.reset();
      return result;
    },
    close() {
      delay.disable();
      observer.disconnect();
    },
  };
}
