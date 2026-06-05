/*
  Warnings:

  - A unique constraint covering the columns `[linked_user_id]` on the table `affiliates` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "affiliates" ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "linked_user_id" UUID;

-- CreateTable
CREATE TABLE "affiliate_email_codes" (
    "code_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_email_codes_pkey" PRIMARY KEY ("code_id")
);

-- CreateIndex
CREATE INDEX "affiliate_email_codes_email_idx" ON "affiliate_email_codes"("email");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_linked_user_id_key" ON "affiliates"("linked_user_id");

-- AddForeignKey
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_linked_user_id_fkey" FOREIGN KEY ("linked_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
