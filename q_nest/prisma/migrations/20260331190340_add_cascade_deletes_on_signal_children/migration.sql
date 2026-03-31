-- DropForeignKey
ALTER TABLE "signal_details" DROP CONSTRAINT "signal_details_signal_id_fkey";

-- DropForeignKey
ALTER TABLE "signal_explanations" DROP CONSTRAINT "signal_explanations_signal_id_fkey";

-- AddForeignKey
ALTER TABLE "signal_details" ADD CONSTRAINT "signal_details_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_explanations" ADD CONSTRAINT "signal_explanations_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE CASCADE ON UPDATE CASCADE;
