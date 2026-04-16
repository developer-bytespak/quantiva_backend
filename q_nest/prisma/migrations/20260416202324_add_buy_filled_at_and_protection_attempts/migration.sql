-- AlterTable
ALTER TABLE "pending_queued_trades" ADD COLUMN     "buy_filled_at" TIMESTAMP(6),
ADD COLUMN     "protection_attempts" INTEGER NOT NULL DEFAULT 0;
