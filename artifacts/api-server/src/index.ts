import "./lib/load-env";
import app from "./app";
import { narrate } from "./lib/agent-narrator";
import { refreshLiveMarket } from "./lib/live-market";
import { logger } from "./lib/logger";
import { runPaperEngineCycle, warmExternalFeeds } from "./lib/trading-engine";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

void warmExternalFeeds()
  .then(() => {
    logger.info("Live market + calendar warmed");
    narrate("Agent tayyor: live narx, taqvim va AI tahlil ulandi.", {
      kind: "agent_boot",
      tone: "good",
    });
  })
  .catch((error: unknown) =>
    logger.warn({ err: error }, "External feeds initial refresh failed"),
  );

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

const marketTimer = setInterval(() => {
  void refreshLiveMarket().catch((error: unknown) => {
    logger.warn({ err: error }, "Live market refresh failed");
  });
}, 20_000);
marketTimer.unref();

const paperCycleTimer = setInterval(() => {
  void runPaperEngineCycle().catch((error: unknown) => {
    logger.error({ err: error }, "Paper trading cycle failed");
  });
}, 30_000);
paperCycleTimer.unref();

const heartbeatTimer = setInterval(() => {
  narrate("Agent jonli: bozorni kuzatyapman, aniq signal bo‘lsa kiraman.", {
    kind: "agent_heartbeat",
    tone: "neutral",
  });
}, 60_000);
heartbeatTimer.unref();
