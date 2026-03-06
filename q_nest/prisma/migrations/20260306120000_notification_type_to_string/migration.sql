-- AlterTable: Change notifications.type from NotificationType enum to VARCHAR(100) without losing data
-- Step 1: Add new column
ALTER TABLE "notifications" ADD COLUMN "type_new" VARCHAR(100);

-- Step 2: Copy data (cast enum to text)
UPDATE "notifications" SET "type_new" = "type"::text;

-- Step 3: Make new column NOT NULL
ALTER TABLE "notifications" ALTER COLUMN "type_new" SET NOT NULL;

-- Step 4: Drop old column
ALTER TABLE "notifications" DROP COLUMN "type";

-- Step 5: Rename new column to type
ALTER TABLE "notifications" RENAME COLUMN "type_new" TO "type";

-- Step 6: Drop the unused enum type
DROP TYPE "NotificationType";
