"use strict";

/**
 * Route-level tests for /api/gas-estimate.
 *
 * The real gas_estimator service runs; only its edges are mocked (Redis cache,
 * the Horizon fee_stats fetch and the XLM price service). That lets these tests
 * pin the response shape consumed by frontend/lib/sorobanFees.ts
 * (GasEstimateResult) and by FeeEstimationModal.tsx, as well as how upstream
 * Horizon / price failures surface to clients.
 */

const express = require("express");
const request = require("supertest");

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

jest.mock("../services/cacheService", () => ({
  get: jest.fn(),
  set: jest.fn(),
}));

jest.mock("../services/xlmPriceService", () => ({
  getXlmUsd7dHistory: jest.fn(),
}));

const cache = require("../services/cacheService");
const { getXlmUsd7dHistory } = require("../services/xlmPriceService");
const gasEstimatorRoutes = require("./gasEstimator");

// Horizon /fee_stats with too few data points for histogram percentiles, so the
// tiers come straight from min/p50/p90 → slow 100, medium 200, fast 400 (+20% on spike).
const SPIKE_FEE_STATS = {
  last_ledger: "5000",
  ledger_base_fee: "100",
  fee_charged: { min: "100", p50: "200", p90: "400" },
};

const CALM_FEE_STATS = {
  last_ledger: "5001",
  ledger_base_fee: "100",
  fee_charged: { min: "100", p50: "110", p90: "120" },
};

function mockHorizon(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    json: async () => body,
  });
}

function expectTier(tier, label) {
  // FeeTier in frontend/lib/sorobanFees.ts: usd is `number | null`
  expect(Object.keys(tier).sort()).toEqual(["label", "stroops", "usd", "xlm"]);
  expect(tier.label).toBe(label);
  expect(typeof tier.stroops).toBe("number");
  expect(typeof tier.xlm).toBe("string");
  expect(tier.usd === null || typeof tier.usd === "number").toBe(true);
}

describe("Gas Estimator Routes (/api/gas-estimate)", () => {
  const originalFetch = global.fetch;
  let app;
  let warnSpy;

  beforeEach(() => {
    jest.resetAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    getXlmUsd7dHistory.mockResolvedValue({ currentPriceUsd: 0.5 });

    app = express();
    app.use(express.json());
    app.use("/api/gas-estimate", gasEstimatorRoutes);
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({
        error: err.message || "Internal server error",
      });
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    global.fetch = originalFetch;
  });

  describe("GET /", () => {
    it("200 — returns the GasEstimateResult shape the frontend consumes", async () => {
      mockHorizon(SPIKE_FEE_STATS);

      const res = await request(app).get("/api/gas-estimate");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { data } = res.body;
      expectTier(data.slow, "slow");
      expectTier(data.medium, "medium");
      expectTier(data.fast, "fast");
      expect(data).toEqual(
        expect.objectContaining({
          spikeDetected: expect.any(Boolean),
          networkCongestion: expect.stringMatching(/^(low|medium|high|unknown)$/),
          ledger: "5000",
          ledgerBaseFeeStroops: 100,
          cached: false,
        })
      );
      expect(Number.isNaN(Date.parse(data.updatedAt))).toBe(false);
      expect(data.fallback).toBeUndefined();
    });

    it("200 — computes slow/medium/fast tiers from Horizon fee stats", async () => {
      mockHorizon(SPIKE_FEE_STATS);

      const { body } = await request(app).get("/api/gas-estimate");

      expect(body.data.slow).toEqual({ label: "slow", stroops: 100, xlm: "0.00001", usd: null });
      expect(body.data.medium).toEqual({ label: "medium", stroops: 200, xlm: "0.00002", usd: null });
      // fast = 400, bumped 20% because the spike is detected
      expect(body.data.fast).toEqual({ label: "fast", stroops: 480, xlm: "0.000048", usd: null });
      expect(body.data.spikeDetected).toBe(true);
      expect(body.data.networkCongestion).toBe("high");
    });

    it("200 — reports low congestion and no spike on a calm network", async () => {
      mockHorizon(CALM_FEE_STATS);

      const { body } = await request(app).get("/api/gas-estimate");

      expect(body.data.spikeDetected).toBe(false);
      expect(body.data.networkCongestion).toBe("low");
      expect(body.data.fast.stroops).toBe(120);
    });

    it("200 — fee tiers are monotonic (slow <= medium <= fast)", async () => {
      mockHorizon(SPIKE_FEE_STATS);

      const { body } = await request(app).get("/api/gas-estimate");

      expect(body.data.slow.stroops).toBeLessThanOrEqual(body.data.medium.stroops);
      expect(body.data.medium.stroops).toBeLessThanOrEqual(body.data.fast.stroops);
    });

    it("does not look up the XLM price unless currency=USD", async () => {
      mockHorizon(CALM_FEE_STATS);

      await request(app).get("/api/gas-estimate");
      await request(app).get("/api/gas-estimate?currency=XLM");
      await request(app).get("/api/gas-estimate?currency=usd");

      expect(getXlmUsd7dHistory).not.toHaveBeenCalled();
    });

    it("200 — fills USD values when currency=USD", async () => {
      mockHorizon(SPIKE_FEE_STATS);

      const { body } = await request(app).get("/api/gas-estimate?currency=USD");

      expect(getXlmUsd7dHistory).toHaveBeenCalledTimes(1);
      // 0.00001 XLM × $0.50
      expect(body.data.slow.usd).toBeCloseTo(0.000005, 10);
      expect(body.data.medium.usd).toBeCloseTo(0.00001, 10);
      expect(body.data.fast.usd).toBeCloseTo(0.000024, 10);
    });

    it("200 — USD values stay null when the price service fails", async () => {
      mockHorizon(SPIKE_FEE_STATS);
      getXlmUsd7dHistory.mockRejectedValue(new Error("price API down"));

      const res = await request(app).get("/api/gas-estimate?currency=USD");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.slow.usd).toBeNull();
      expect(res.body.data.fast.usd).toBeNull();
    });

    it("200 — USD values stay null when the price service returns no price", async () => {
      mockHorizon(SPIKE_FEE_STATS);
      getXlmUsd7dHistory.mockResolvedValue(null);

      const res = await request(app).get("/api/gas-estimate?currency=USD");

      expect(res.status).toBe(200);
      expect(res.body.data.medium.usd).toBeNull();
    });

    it("200 — serves a cached estimate with cached=true without calling Horizon", async () => {
      mockHorizon(SPIKE_FEE_STATS);
      const cachedEstimate = {
        slow: { label: "slow", stroops: 100, xlm: "0.00001", usd: null },
        medium: { label: "medium", stroops: 200, xlm: "0.00002", usd: null },
        fast: { label: "fast", stroops: 300, xlm: "0.00003", usd: null },
        spikeDetected: false,
        networkCongestion: "low",
        ledger: "4999",
        ledgerBaseFeeStroops: 100,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      cache.get.mockResolvedValue(cachedEstimate);

      const res = await request(app).get("/api/gas-estimate");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ ...cachedEstimate, cached: true });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("200 — returns protocol-minimum fallback fees when Horizon times out", async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      global.fetch = jest.fn().mockRejectedValue(timeout);

      const res = await request(app).get("/api/gas-estimate");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          slow: { label: "slow", stroops: 100, xlm: "0.00001", usd: null },
          medium: { label: "medium", stroops: 200, xlm: "0.00002", usd: null },
          fast: { label: "fast", stroops: 1000, xlm: "0.0001", usd: null },
          spikeDetected: false,
          networkCongestion: "unknown",
          ledger: null,
          ledgerBaseFeeStroops: 100,
          cached: false,
          fallback: true,
        })
      );
      expect(cache.set).not.toHaveBeenCalled();
    });

    it("200 — returns fallback fees when Horizon responds with a 5xx", async () => {
      mockHorizon({}, { ok: false, status: 503, statusText: "Service Unavailable" });

      const res = await request(app).get("/api/gas-estimate");

      expect(res.status).toBe(200);
      expect(res.body.data.fallback).toBe(true);
      expect(res.body.data.networkCongestion).toBe("unknown");
    });

    it("200 — fallback estimate carries USD values when currency=USD", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));

      const res = await request(app).get("/api/gas-estimate?currency=USD");

      expect(res.status).toBe(200);
      expect(res.body.data.fallback).toBe(true);
      expect(res.body.data.slow.usd).toBeCloseTo(0.000005, 10);
    });

    it("200 — still responds when the cache read fails", async () => {
      cache.get.mockRejectedValue(new Error("redis unavailable"));
      mockHorizon(SPIKE_FEE_STATS);

      const res = await request(app).get("/api/gas-estimate");

      expect(res.status).toBe(200);
      expect(res.body.data.fallback).toBe(true);
    });
  });

  describe("POST /refresh", () => {
    it("200 — bypasses the cache and stores the fresh estimate", async () => {
      cache.get.mockResolvedValue({ stale: true });
      mockHorizon(SPIKE_FEE_STATS);

      const res = await request(app).post("/api/gas-estimate/refresh");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(cache.get).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(res.body.data.cached).toBe(false);
      expect(res.body.data.stale).toBeUndefined();
      expectTier(res.body.data.slow, "slow");
    });

    it("200 — includes USD values when the price is available", async () => {
      mockHorizon(SPIKE_FEE_STATS);

      const { body } = await request(app).post("/api/gas-estimate/refresh");

      expect(getXlmUsd7dHistory).toHaveBeenCalledTimes(1);
      expect(body.data.slow.usd).toBeCloseTo(0.000005, 10);
    });

    it("200 — USD values stay null when the price service fails", async () => {
      mockHorizon(SPIKE_FEE_STATS);
      getXlmUsd7dHistory.mockRejectedValue(new Error("price API down"));

      const res = await request(app).post("/api/gas-estimate/refresh");

      expect(res.status).toBe(200);
      expect(res.body.data.slow.usd).toBeNull();
    });

    it("200 — returns fallback fees when Horizon is unreachable", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await request(app).post("/api/gas-estimate/refresh");

      expect(res.status).toBe(200);
      expect(res.body.data.fallback).toBe(true);
    });

    it("404 — GET is not supported on /refresh", async () => {
      const res = await request(app).get("/api/gas-estimate/refresh");

      expect(res.status).toBe(404);
    });
  });
});
