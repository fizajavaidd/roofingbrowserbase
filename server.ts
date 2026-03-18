import "dotenv/config";
import { declineQuotesOnPage } from "./decline-quotes-module.js";
import express from "express";
import { runBookingTask } from "./browserbase-booking-task-module.js";
import { getAppointmentPageCount } from "./appointment-page-count-module.js";
import crypto from "crypto";

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET || "change-me-to-a-real-secret";

// In-memory task store
const tasks: Record<string, {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  result: string;
  jobsProcessed: number;
  quotesDeclined: number;
  startedAt: string;
  completedAt: string | null;
}> = {};

// Clean up old tasks every 30 minutes (keep last 2 hours)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const id of Object.keys(tasks)) {
    const t = tasks[id];
    if (t.completedAt && new Date(t.completedAt).getTime() < cutoff) {
      delete tasks[id];
    }
  }
}, 30 * 60 * 1000);

function authCheck(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (token !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({ service: "stratablue-automation-api", status: "running" });
});

// Booking endpoint
app.post("/book", authCheck, async (req, res) => {
  const startTime = Date.now();
  console.log(`\n📥 Received booking request at ${new Date().toISOString()}`);
  console.log(`   Customer: ${req.body.firstName} ${req.body.lastName}`);
  console.log(`   Address: ${req.body.serviceAddress}`);
  try {
    const result = await runBookingTask(req.body);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`📤 Completed in ${elapsed}s — success: ${result.success}\n`);
    res.json({
      success: result.success,
      message: result.context?.completionMessage || null,
      stepsRun: result.stepsRun,
      stepsSkipped: result.stepsSkipped,
      totalSteps: result.totalSteps,
      elapsedMinutes: result.elapsedMinutes,
      sessionUrl: result.sessionUrl || null,
      context: result.context,
    });
  } catch (error: any) {
    console.error(`❌ Task failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Appointment page count endpoint
app.post("/appointment-pages", authCheck, async (req, res) => {
  const dateFilter = req.body.dateFilter;
  if (!dateFilter) {
    res.status(400).json({ error: "Missing required field: dateFilter" });
    return;
  }
  console.log(`\n📥 Appointment pages request: dateFilter=${dateFilter}`);
  try {
    const result = await getAppointmentPageCount({ dateFilter });
    console.log(`📤 Result: ${result.status} — ${result.result}`);
    res.json({ data: { status: result.status, result: result.result } });
  } catch (error: any) {
    console.error(`❌ Failed: ${error.message}`);
    res.status(500).json({ data: { status: "FAILED", result: error.message } });
  }
});

// Decline quotes — starts task in background, returns taskId
app.post("/decline-quotes", authCheck, async (req, res) => {
  const { dateFilter, pageNumber } = req.body;
  if (!dateFilter || !pageNumber) {
    res.status(400).json({ error: "Missing required fields: dateFilter, pageNumber" });
    return;
  }

  const taskId = crypto.randomUUID();
  console.log(`\n📥 Decline quotes: page=${pageNumber}, dateFilter=${dateFilter}, taskId=${taskId}`);

  // Store task as running
  tasks[taskId] = {
    status: "RUNNING",
    result: `Processing page ${pageNumber}...`,
    jobsProcessed: 0,
    quotesDeclined: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  // Respond immediately with taskId
  res.json({
    data: {
      status: "STARTED",
      taskId,
      message: `Task started for page ${pageNumber}. Poll GET /task/${taskId} for result.`,
    },
  });

  // Run in background
  declineQuotesOnPage({ dateFilter, pageNumber })
    .then((result) => {
      console.log(`📤 Task ${taskId} done: ${result.status} — ${result.result}`);
      tasks[taskId] = {
        status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
        result: result.result,
        jobsProcessed: result.jobsProcessed,
        quotesDeclined: result.quotesDeclined,
        startedAt: tasks[taskId].startedAt,
        completedAt: new Date().toISOString(),
      };
    })
    .catch((error) => {
      console.error(`❌ Task ${taskId} failed: ${error.message}`);
      tasks[taskId] = {
        status: "FAILED",
        result: `Error: ${error.message}`,
        jobsProcessed: 0,
        quotesDeclined: 0,
        startedAt: tasks[taskId].startedAt,
        completedAt: new Date().toISOString(),
      };
    });
});

// Poll task status
app.get("/task/:taskId", authCheck, (req, res) => {
  const task = tasks[req.params.taskId];
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({
    data: {
      status: task.status,
      result: task.result,
      jobsProcessed: task.jobsProcessed,
      quotesDeclined: task.quotesDeclined,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    },
  });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API running on port ${PORT}`);
  console.log(`   POST /book               — run a booking`);
  console.log(`   POST /appointment-pages   — get appointment page count`);
  console.log(`   POST /decline-quotes      — start decline task (returns taskId)`);
  console.log(`   GET  /task/:taskId        — poll task status`);
  console.log(`   GET  /health             — health check`);
});