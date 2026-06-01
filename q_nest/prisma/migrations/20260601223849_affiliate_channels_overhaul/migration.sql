/*
  Warnings:

  - The values [NEWSLETTER,BLOG,DISCORD_TELEGRAM,PODCAST] on the enum `AffiliateChannel` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "AffiliateChannel_new" AS ENUM ('YOUTUBE', 'X', 'INSTAGRAM', 'TIKTOK', 'DISCORD', 'TELEGRAM', 'OTHER');
ALTER TABLE "affiliate_applications" ALTER COLUMN "primary_channel" TYPE "AffiliateChannel_new" USING ("primary_channel"::text::"AffiliateChannel_new");
ALTER TYPE "AffiliateChannel" RENAME TO "AffiliateChannel_old";
ALTER TYPE "AffiliateChannel_new" RENAME TO "AffiliateChannel";
DROP TYPE "public"."AffiliateChannel_old";
COMMIT;

-- AlterTable
ALTER TABLE "affiliate_applications" ADD COLUMN     "additional_channels" JSONB,
ADD COLUMN     "primary_channel_custom_name" VARCHAR(120);
