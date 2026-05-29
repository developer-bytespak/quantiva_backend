-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "exchange" VARCHAR(20),
ADD COLUMN     "primary_index_code" VARCHAR(20),
ADD COLUMN     "signal_eligible" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "indexes" (
    "index_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "is_derived" BOOLEAN NOT NULL DEFAULT false,
    "source_url" TEXT,
    "reconstitution_cadence" VARCHAR(20),
    "last_refreshed" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexes_pkey" PRIMARY KEY ("index_id")
);

-- CreateTable
CREATE TABLE "index_membership" (
    "index_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "symbol" VARCHAR(10) NOT NULL,
    "added_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(6),
    "weight" DECIMAL(10,6),

    CONSTRAINT "index_membership_pkey" PRIMARY KEY ("index_id","asset_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "indexes_code_key" ON "indexes"("code");

-- CreateIndex
CREATE INDEX "index_membership_asset_id_idx" ON "index_membership"("asset_id");

-- CreateIndex
CREATE INDEX "index_membership_symbol_idx" ON "index_membership"("symbol");

-- CreateIndex
CREATE INDEX "assets_primary_index_code_idx" ON "assets"("primary_index_code");

-- AddForeignKey
ALTER TABLE "index_membership" ADD CONSTRAINT "index_membership_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "indexes"("index_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_membership" ADD CONSTRAINT "index_membership_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE CASCADE ON UPDATE CASCADE;
