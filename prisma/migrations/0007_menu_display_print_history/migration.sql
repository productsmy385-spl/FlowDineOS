-- CreateEnum
CREATE TYPE "menu_style" AS ENUM ('RING', 'GRID');

-- CreateEnum
CREATE TYPE "daily_style" AS ENUM ('STRIP', 'GRID');

-- AlterTable
ALTER TABLE "print_jobs" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "archived_by_user_id" UUID;

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "daily_style" "daily_style" NOT NULL DEFAULT 'STRIP',
ADD COLUMN     "menu_style" "menu_style" NOT NULL DEFAULT 'RING';

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_archived_by_user_id_fkey" FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A job still waiting for, or at, the printer can never be hidden from the queue; archived jobs name who did it.
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_archive_finished_only_check"
  CHECK ("archived_at" IS NULL OR ("status" IN ('PRINTED', 'FAILED') AND "archived_by_user_id" IS NOT NULL));
