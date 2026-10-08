-- CreateEnum
CREATE TYPE "printer_check_status" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "print_job_status" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "print_jobs" ADD COLUMN     "cancel_reason" VARCHAR(200),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_by_user_id" UUID,
ADD COLUMN     "retry_window_started_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "printers" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_delivered_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_error_code" VARCHAR(40),
ADD COLUMN     "last_failed_at" TIMESTAMPTZ(6),
ADD COLUMN     "profile" VARCHAR(40) NOT NULL DEFAULT 'GENERIC_ESCPOS';

-- CreateTable
CREATE TABLE "printer_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "printer_id" UUID NOT NULL,
    "print_agent_id" UUID NOT NULL,
    "status" "printer_check_status" NOT NULL DEFAULT 'REQUESTED',
    "ok" BOOLEAN,
    "error_code" VARCHAR(40),
    "detail" VARCHAR(200),
    "elapsed_ms" INTEGER,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "printer_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "printer_checks_tenant_id_print_agent_id_status_idx" ON "printer_checks"("tenant_id", "print_agent_id", "status");

-- CreateIndex
CREATE INDEX "printer_checks_tenant_id_printer_id_requested_at_idx" ON "printer_checks"("tenant_id", "printer_id", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "printer_checks_tenant_id_id_key" ON "printer_checks"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "printer_checks" ADD CONSTRAINT "printer_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_checks" ADD CONSTRAINT "printer_checks_tenant_id_printer_id_fkey" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "printers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_checks" ADD CONSTRAINT "printer_checks_tenant_id_print_agent_id_fkey" FOREIGN KEY ("tenant_id", "print_agent_id") REFERENCES "print_agents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_checks" ADD CONSTRAINT "printer_checks_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Printing hardening (knowledge/implementation/printing-audit-2026-10-08.md). Additive only.
-- A kitchen ticket now retries for up to 30 minutes (about 12 attempts), so the attempt cap is raised from 10 to 30.
ALTER TABLE "print_jobs" DROP CONSTRAINT "print_jobs_max_attempts_check";
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_max_attempts_check" CHECK ("max_attempts" BETWEEN 1 AND 30);

-- Cancelled jobs are finished too and may be cleared from the history. Compared as text: a value added to an enum
-- cannot be used as an enum literal in the same transaction.
ALTER TABLE "print_jobs" DROP CONSTRAINT "print_jobs_archive_finished_only_check";
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_archive_finished_only_check"
  CHECK ("archived_at" IS NULL OR ("status"::text IN ('PRINTED', 'FAILED', 'CANCELLED') AND "archived_by_user_id" IS NOT NULL));
-- A cancellation always names who cancelled it.
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_cancelled_by_check" CHECK ("cancelled_at" IS NULL OR "cancelled_by_user_id" IS NOT NULL);

ALTER TABLE "printers" ADD CONSTRAINT "printers_profile_check" CHECK ("profile" ~ '^[A-Z0-9_]{3,40}$');
-- Only a deactivated printer can be archived.
ALTER TABLE "printers" ADD CONSTRAINT "printers_archived_inactive_check" CHECK ("archived_at" IS NULL OR "is_active" = false);

ALTER TABLE "printer_checks" ADD CONSTRAINT "printer_checks_elapsed_ms_check" CHECK ("elapsed_ms" IS NULL OR "elapsed_ms" >= 0);
ALTER TABLE "printer_checks" ADD CONSTRAINT "printer_checks_completed_check" CHECK ("status" <> 'COMPLETED' OR ("ok" IS NOT NULL AND "completed_at" IS NOT NULL));
