-- Simplified order workflow (owner brief 2026-10-13): a per-restaurant switch, off by default so every existing
-- restaurant keeps the manual kitchen workflow until an administrator turns it on.
-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "simplified_workflow" BOOLEAN NOT NULL DEFAULT false;
