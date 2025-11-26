-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "device_id" VARCHAR(255),
ADD COLUMN     "ip_address" VARCHAR(45),
ADD COLUMN     "refresh_token_hash" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "two_factor_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "two_factor_secret" VARCHAR(255);

-- CreateTable
CREATE TABLE "two_factor_codes" (
    "code_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "purpose" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_codes_pkey" PRIMARY KEY ("code_id")
);

-- CreateIndex
CREATE INDEX "two_factor_codes_user_id_idx" ON "two_factor_codes"("user_id");

-- CreateIndex
CREATE INDEX "two_factor_codes_expires_at_idx" ON "two_factor_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "two_factor_codes" ADD CONSTRAINT "two_factor_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
