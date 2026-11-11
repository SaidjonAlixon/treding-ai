import { Router, type IRouter } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import {
  CloseTradingPositionParams,
  CloseTradingPositionResponse,
  ControlTradingEngineBody,
  ControlTradingEngineResponse,
  EnterTradingSignalParams,
  EnterTradingSignalResponse,
  EvaluateTradingSignalBody,
  EvaluateTradingSignalResponse,
  GetTradingAuditQueryParams,
  GetTradingAuditResponse,
  GetTradingBacktestsResponse,
  GetTradingDashboardResponse,
  GetTradingPositionsResponse,
  GetTradingSettingsResponse,
  GetTradingSignalsResponse,
  RunTradingBacktestBody,
  RunTradingBacktestResponse,
  UpdateTradingSettingsBody,
  UpdateTradingSettingsResponse,
} from "@workspace/api-zod";
import {
  closeTradingPosition,
  controlEngine,
  createTradingBacktest,
  enterTradingSignal,
  evaluateTradingSignal,
  getDashboard,
  getTradingAudit,
  getTradingBacktests,
  getTradingPositions,
  getTradingSettings,
  getTradingSignals,
  updateTradingSettings,
} from "../lib/trading-engine";

const router: IRouter = Router();
const localDevAuth = process.env.LOCAL_DEV_AUTH === "1";

router.use(async (req, res, next): Promise<void> => {
  if (localDevAuth) {
    next();
    return;
  }

  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Kirish talab qilinadi." });
    return;
  }

  const adminEmail = process.env.TRADING_ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) {
    res.status(503).json({
      error: "Platforma administratori hali sozlanmagan.",
    });
    return;
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const userEmail = user.primaryEmailAddress?.emailAddress
      .trim()
      .toLowerCase();
    if (!userEmail || userEmail !== adminEmail) {
      res.status(403).json({ error: "Bu hisobga boshqaruv ruxsati berilmagan." });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ err: error, userId }, "Could not verify trading admin");
    res.status(503).json({
      error: "Administrator ruxsatini tekshirib bo‘lmadi.",
    });
  }
});

router.get("/trading/dashboard", async (_req, res): Promise<void> => {
  const response = GetTradingDashboardResponse.passthrough().parse(
    await getDashboard(),
  );
  res.json(response);
});

router.get("/trading/settings", async (_req, res): Promise<void> => {
  const response = GetTradingSettingsResponse.parse(await getTradingSettings());
  res.json(response);
});

router.patch("/trading/settings", async (req, res): Promise<void> => {
  const parsed = UpdateTradingSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const response = UpdateTradingSettingsResponse.parse(
      await updateTradingSettings(parsed.data),
    );
    res.json(response);
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : "Could not update settings.",
    });
  }
});

router.post("/trading/engine", async (req, res): Promise<void> => {
  const parsed = ControlTradingEngineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const response = ControlTradingEngineResponse.parse(
      await controlEngine(parsed.data.action),
    );
    res.json(response);
  } catch (error) {
    res.status(409).json({
      error:
        error instanceof Error ? error.message : "Could not change engine state.",
    });
  }
});

router.get("/trading/signals", async (_req, res): Promise<void> => {
  const response = GetTradingSignalsResponse.parse(await getTradingSignals());
  res.json(response);
});

router.post("/trading/signals/evaluate", async (req, res): Promise<void> => {
  const parsed = EvaluateTradingSignalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const response = EvaluateTradingSignalResponse.parse(
    await evaluateTradingSignal(parsed.data.symbol),
  );
  res.json(response);
});

router.post("/trading/signals/:signalId/enter", async (req, res): Promise<void> => {
  const parsed = EnterTradingSignalParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const position = await enterTradingSignal(parsed.data.signalId);
    if (!position) {
      res.status(404).json({ error: "Signal topilmadi." });
      return;
    }
    const response = EnterTradingSignalResponse.parse(position);
    res.json(response);
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : "Kirishni bajarib bo‘lmadi.",
    });
  }
});

router.get("/trading/positions", async (_req, res): Promise<void> => {
  const response = GetTradingPositionsResponse.parse(
    await getTradingPositions(),
  );
  res.json(response);
});

router.post(
  "/trading/positions/:positionId/close",
  async (req, res): Promise<void> => {
    const parsed = CloseTradingPositionParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const position = await closeTradingPosition(parsed.data.positionId);
    if (!position) {
      res.status(404).json({ error: "Open paper position not found." });
      return;
    }
    const response = CloseTradingPositionResponse.parse(position);
    res.json(response);
  },
);

router.get("/trading/audit", async (req, res): Promise<void> => {
  const parsed = GetTradingAuditQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const response = GetTradingAuditResponse.parse(
    await getTradingAudit(parsed.data.limit ?? 30),
  );
  res.json(response);
});

router.get("/trading/backtests", async (_req, res): Promise<void> => {
  const response = GetTradingBacktestsResponse.parse(
    await getTradingBacktests(),
  );
  res.json(response);
});

router.post("/trading/backtests", async (req, res): Promise<void> => {
  const parsed = RunTradingBacktestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const response = RunTradingBacktestResponse.parse(
      await createTradingBacktest(parsed.data),
    );
    res.json(response);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Backtest failed.",
    });
  }
});

export default router;
