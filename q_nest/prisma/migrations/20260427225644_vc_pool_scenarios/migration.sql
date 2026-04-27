-- AlterTable
ALTER TABLE "admins" ALTER COLUMN "payment_network" SET DEFAULT 'TRC20';

-- AlterTable
ALTER TABLE "vc_pool_payment_submissions" ADD COLUMN     "admin_exchange_name" VARCHAR(50),
ADD COLUMN     "payment_network_used" VARCHAR(20);
