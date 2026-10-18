"use strict";

/**
 * Route-level tests for /api/turrets.
 *
 * turretsService is fully mocked, so these tests pin the HTTP contract of the
 * router: request validation, status-code mapping for service errors, and the
 * response envelope ({ success, data }) that clients depend on.
 * (POST /sign is additionally covered end-to-end in tests/turrets.test.js.)
 */

const express = require("express");
const request = require("supertest");

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

jest.mock("../services/turretsService", () => ({
  submitTransaction: jest.fn(),
  signTransaction: jest.fn(),
  getTurretStatus: jest.fn(),
  estimateTurretFee: jest.fn(),
  shouldUseTurret: jest.fn(),
}));

const {
  submitTransaction,
  signTransaction,
  getTurretStatus,
  estimateTurretFee,
  shouldUseTurret,
} = require("../services/turretsService");
const turretRoutes = require("./turrets");

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

describe("Turrets Routes (/api/turrets)", () => {
  let app;
  let consoleErrorSpy;

  beforeEach(() => {
    jest.resetAllMocks();
    // The app-level error handler logs via console.error
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    app = express();
    app.use(express.json());
    app.use("/api/turrets", turretRoutes);
    // Mirrors the error handler in src/server.js
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({
        error: err.message || "Internal server error",
      });
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("POST /sign", () => {
    it("400 — rejects a missing transactionXDR without calling the service", async () => {
      const res = await request(app)
        .post("/api/turrets/sign")
        .send({ escrowId: "GCESCROW" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: "Transaction XDR is required",
      });
      expect(signTransaction).not.toHaveBeenCalled();
    });

    it("400 — rejects a missing escrowId without calling the service", async () => {
      const res = await request(app)
        .post("/api/turrets/sign")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: "Escrow ID is required for authorization",
      });
      expect(signTransaction).not.toHaveBeenCalled();
    });

    it("200 — wraps the signed result in { success, data }", async () => {
      const signed = {
        success: true,
        signedXDR: "SIGNED_XDR",
        escrowId: "GCESCROW",
        turretUsed: true,
        message: "Transaction signed by turret for authorized escrow",
      };
      signTransaction.mockResolvedValue(signed);

      const res = await request(app)
        .post("/api/turrets/sign")
        .send({ transactionXDR: "AAAA", escrowId: "GCESCROW" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: signed });
      expect(signTransaction).toHaveBeenCalledWith("AAAA", "GCESCROW");
    });

    it.each([
      [403, "Unauthorized escrow ID"],
      [500, "Turret signing key not configured"],
    ])("%i — propagates service error status and message", async (status, message) => {
      signTransaction.mockRejectedValue(statusError(message, status));

      const res = await request(app)
        .post("/api/turrets/sign")
        .send({ transactionXDR: "AAAA", escrowId: "GXXX" });

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: message });
    });
  });

  describe("POST /submit", () => {
    it("400 — rejects a missing transactionXDR", async () => {
      const res = await request(app).post("/api/turrets/submit").send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Transaction XDR is required" });
      expect(submitTransaction).not.toHaveBeenCalled();
    });

    it("400 — rejects an empty transactionXDR string", async () => {
      const res = await request(app)
        .post("/api/turrets/submit")
        .send({ transactionXDR: "" });

      expect(res.status).toBe(400);
      expect(submitTransaction).not.toHaveBeenCalled();
    });

    it("200 — returns the submission result in { success, data }", async () => {
      const result = {
        success: true,
        hash: "abc123",
        ledger: 4242,
        feeCharged: "100",
        turretUsed: true,
        message: "Transaction submitted via Stellar Turret",
      };
      submitTransaction.mockResolvedValue(result);

      const res = await request(app)
        .post("/api/turrets/submit")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: result });
    });

    it.each([[true], [false], [undefined]])(
      "forwards useTurret=%s to the service as an option",
      async (useTurret) => {
        submitTransaction.mockResolvedValue({ success: true });

        await request(app)
          .post("/api/turrets/submit")
          .send({ transactionXDR: "AAAA", useTurret });

        expect(submitTransaction).toHaveBeenCalledWith("AAAA", { useTurret });
      }
    );

    it("200 — reports a direct-Horizon fallback via turretUsed=false", async () => {
      submitTransaction.mockResolvedValue({
        success: true,
        hash: "def456",
        turretUsed: false,
        message: "Transaction submitted directly (Turret unavailable)",
      });

      const res = await request(app)
        .post("/api/turrets/submit")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(200);
      expect(res.body.data.turretUsed).toBe(false);
    });

    it.each([
      [400, "Turret error: Invalid transaction"],
      [429, "Turret rate limit exceeded. Please try again later."],
      [503, "Turret service temporarily unavailable"],
      [500, "Both Turret and direct submission failed: Horizon timeout"],
    ])("%i — propagates upstream failure from the service", async (status, message) => {
      submitTransaction.mockRejectedValue(statusError(message, status));

      const res = await request(app)
        .post("/api/turrets/submit")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: message });
    });

    it("500 — maps an error without a status to a generic server error", async () => {
      submitTransaction.mockRejectedValue(new Error("boom"));

      const res = await request(app)
        .post("/api/turrets/submit")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "boom" });
    });
  });

  describe("GET /status", () => {
    it("200 — returns the turret status in { success, data }", async () => {
      const status = {
        available: true,
        url: "https://tss.stellar.org",
        network: "testnet",
        version: "1.0.0",
        feeSponsorship: true,
        message: "Turret service available",
      };
      getTurretStatus.mockResolvedValue(status);

      const res = await request(app).get("/api/turrets/status");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: status });
    });

    it("200 — surfaces an unavailable turret as data, not an HTTP error", async () => {
      getTurretStatus.mockResolvedValue({
        available: false,
        url: "https://tss.stellar.org",
        message: "Turret service unavailable",
        error: "timeout of 5000ms exceeded",
      });

      const res = await request(app).get("/api/turrets/status");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.available).toBe(false);
    });

    it("500 — propagates an unexpected service failure", async () => {
      getTurretStatus.mockRejectedValue(new Error("unexpected"));

      const res = await request(app).get("/api/turrets/status");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "unexpected" });
    });
  });

  describe("POST /estimate", () => {
    it("400 — rejects a missing transactionXDR", async () => {
      const res = await request(app).post("/api/turrets/estimate").send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Transaction XDR is required" });
      expect(estimateTurretFee).not.toHaveBeenCalled();
    });

    it("200 — returns the fee estimation shape in { success, data }", async () => {
      const estimation = {
        success: true,
        baseFee: "100",
        turretFee: "50",
        totalFee: "150",
        feeSponsored: false,
      };
      estimateTurretFee.mockResolvedValue(estimation);

      const res = await request(app)
        .post("/api/turrets/estimate")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: estimation });
      expect(estimateTurretFee).toHaveBeenCalledWith("AAAA");
      // Fee fields are string stroop amounts — keep the type stable
      for (const key of ["baseFee", "turretFee", "totalFee"]) {
        expect(typeof res.body.data[key]).toBe("string");
      }
      expect(typeof res.body.data.feeSponsored).toBe("boolean");
    });

    it("200 — keeps the same shape when the service falls back to default fees", async () => {
      estimateTurretFee.mockResolvedValue({
        success: false,
        baseFee: "100",
        turretFee: "0",
        totalFee: "100",
        feeSponsored: false,
        message: "Unable to estimate Turret fees, using default",
      });

      const res = await request(app)
        .post("/api/turrets/estimate")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          success: false,
          baseFee: "100",
          turretFee: "0",
          totalFee: "100",
          feeSponsored: false,
        })
      );
    });

    it("propagates a service error status", async () => {
      estimateTurretFee.mockRejectedValue(statusError("Turret URL not configured", 500));

      const res = await request(app)
        .post("/api/turrets/estimate")
        .send({ transactionXDR: "AAAA" });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Turret URL not configured" });
    });
  });

  describe("GET /config", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("200 — reports a configured turret without leaking the API key", async () => {
      process.env.TURRET_URL = "https://turret.example.com";
      process.env.TURRET_API_KEY = "super-secret-key";
      shouldUseTurret.mockReturnValue(true);

      const res = await request(app).get("/api/turrets/config");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          configured: true,
          url: "https://turret.example.com",
          hasApiKey: true,
          shouldUseByDefault: true,
        },
      });
      expect(JSON.stringify(res.body)).not.toContain("super-secret-key");
    });

    it("200 — reports an unconfigured turret with null url", async () => {
      delete process.env.TURRET_URL;
      delete process.env.TURRET_API_KEY;
      shouldUseTurret.mockReturnValue(false);

      const res = await request(app).get("/api/turrets/config");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        configured: false,
        url: null,
        hasApiKey: false,
        shouldUseByDefault: false,
      });
    });
  });
});
