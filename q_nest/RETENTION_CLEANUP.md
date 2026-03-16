# Retention & Cleanup – 5 Tables Implementation

This document describes the retention (time-based delete) added for 5 tables to control database size. Cleanup runs inside the **existing** task-scheduler cron (no separate cron).

---

## Summary

| # | Table | Retention (delete after) | Config (env) | Default |
|---|--------|--------------------------|---------------|---------|
| 1 | **strategy_signals** | 30 days | `SIGNAL_RETENTION_DAYS` | 30 |
| 2 | **signal_details** | 30 days | `SIGNAL_RETENTION_DAYS` | 30 |
| 3 | **signal_explanations** | 30 days | `SIGNAL_RETENTION_DAYS` | 30 |
| 4 | **asset_metrics** | 90 days | `METRICS_RETENTION_DAYS` | 90 |
| 5 | **strategy_execution_jobs** | 14 days | `JOBS_RETENTION_DAYS` | 14 |

**Total tables with new retention:** 5

---

## Where It Runs

- **File:** `src/task-scheduler/task-scheduler.service.ts`
- **Cron:** Same daily cleanup cron – **2 AM UTC** (`0 2 * * *`)
- **Method:** `handleScheduledCleanup()` → `runCleanup()` which now also runs the 5 new cleanups.

No new cron was added; retention is part of the existing task-scheduler.

---

## Delete Order (FK-safe)

1. **signal_details** – child of `strategy_signals` (delete first)
2. **signal_explanations** – child of `strategy_signals` (delete first)
3. **strategy_signals** – parent (delete after children)
4. **asset_metrics** – no dependency on above
5. **strategy_execution_jobs** – only completed/failed jobs older than cutoff

---

## Date Fields Used

| Table | Field used for cutoff |
|--------|------------------------|
| strategy_signals | `timestamp` |
| signal_details | (via parent) `signal.timestamp` |
| signal_explanations | (via parent) `signal.timestamp` |
| asset_metrics | `metric_date` |
| strategy_execution_jobs | `completed_at` or `scheduled_at` (if `completed_at` is null) |

---

## Optional Env Config

Add to `.env` if you want to override defaults:

```env
# Retention days (optional; defaults in code)
SIGNAL_RETENTION_DAYS=30
METRICS_RETENTION_DAYS=90
JOBS_RETENTION_DAYS=14

# Existing
DATA_RETENTION_DAYS=5
CLEANUP_BATCH_SIZE=100
```

---

## Manual Trigger & Status

- **Manual cleanup:** `GET /admin/cleanup/trigger`
- **Status (includes retention config):** `GET /admin/cleanup/status`

Response now includes:

- `configuration.signalRetentionDays`
- `configuration.metricsRetentionDays`
- `configuration.jobsRetentionDays`
- `configuration.dataRetentionDays` (news/trending_assets)

---

## Metrics Returned

`CleanupMetrics` (and manual trigger response) now includes:

- `signalsDeleted`
- `signalDetailsDeleted`
- `signalExplanationsDeleted`
- `assetMetricsDeleted`
- `strategyJobsDeleted`

(Plus existing `newsDeleted`, `trendingAssetsDeleted`.)

---

## What Was Done (Implementation Summary)

1. **Config:** Added `SIGNAL_RETENTION_DAYS`, `METRICS_RETENTION_DAYS`, `JOBS_RETENTION_DAYS` (defaults 30, 90, 14).
2. **CleanupMetrics:** Extended with 5 new counters for the 5 tables.
3. **runCleanup():** After existing `trending_news` and `trending_assets` cleanup, added calls to:
   - `cleanupSignalDetails(signalCutoff)`
   - `cleanupSignalExplanations(signalCutoff)`
   - `cleanupStrategySignals(signalCutoff)`
   - `cleanupAssetMetrics(metricsCutoff)`
   - `cleanupStrategyExecutionJobs(jobsCutoff)`
4. **New private methods:** One per table (with FK order and batching where needed).
5. **getStatus():** Now exposes all retention days (data, signal, metrics, jobs) and batch size.

---

*Document created for retention cleanup implementation on the 5 tables.*
