import { describe, it, expect, beforeEach } from "vitest";

import {
  forwardedMessagesCounter,
  getRegistry,
  httpRequestDurationSeconds,
  pendingRequestsGauge,
  sseClientsGauge,
} from "./metrics";

describe("metrics", () => {
  beforeEach(async () => {
    getRegistry().resetMetrics();
  });

  it("exports a registry with default metrics prefix", async () => {
    const metrics = await getRegistry().metrics();
    expect(metrics).toContain("mabl_mcp_proxy_");
  });

  it("tracks forwarded messages counter", async () => {
    forwardedMessagesCounter.inc();
    forwardedMessagesCounter.inc();
    const val = await getRegistry().getSingleMetricAsString(
      "forwarded_messages_total",
    );
    expect(val).toContain("2");
  });

  it("tracks pending requests gauge", async () => {
    pendingRequestsGauge.set(5);
    const val = await getRegistry().getSingleMetricAsString("pending_requests");
    expect(val).toContain("5");
  });

  it("tracks SSE clients gauge", async () => {
    sseClientsGauge.inc();
    sseClientsGauge.inc();
    sseClientsGauge.dec();
    const val = await getRegistry().getSingleMetricAsString("sse_clients");
    expect(val).toContain("1");
  });

  it("tracks HTTP request duration histogram", () => {
    expect(httpRequestDurationSeconds).toBeDefined();
    const timer = httpRequestDurationSeconds.startTimer();
    timer({ method: "GET", route: "/test", status_code: "200" });
  });
});
