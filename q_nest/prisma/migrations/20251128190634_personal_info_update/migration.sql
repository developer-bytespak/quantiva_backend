-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dob" DATE,
ADD COLUMN     "full_name" VARCHAR(120),
ADD COLUMN     "gender" VARCHAR(50),
ADD COLUMN     "nationality" VARCHAR(100),
ADD COLUMN     "phone_number" VARCHAR(20);
