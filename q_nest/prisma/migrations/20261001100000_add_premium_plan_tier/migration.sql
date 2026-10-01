-- AlterEnum
-- Must live in its own migration: Postgres cannot reference a freshly added enum
-- value inside the same transaction that added it.
ALTER TYPE "PlanTier" ADD VALUE IF NOT EXISTS 'PREMIUM';
