-- AlterTable
ALTER TABLE "printers" ADD COLUMN "auto_print_kot" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "printers" ADD COLUMN "kot_copies" SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE "printers" ADD COLUMN "auto_print_receipt" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "printers" ADD COLUMN "receipt_copies" SMALLINT NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "print_jobs" ADD COLUMN "copy_index" SMALLINT;
ALTER TABLE "print_jobs" ADD COLUMN "copy_count" SMALLINT;
ALTER TABLE "print_jobs" ADD COLUMN "copy_label" VARCHAR(40);
ALTER TABLE "print_jobs" ADD COLUMN "payment_reference" VARCHAR(64);
ALTER TABLE "print_jobs" ADD COLUMN "trigger" VARCHAR(20);
