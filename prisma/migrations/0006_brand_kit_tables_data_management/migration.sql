-- CreateEnum
CREATE TYPE "backup_reminder" AS ENUM ('MANUAL', 'MONTHLY', 'SIX_MONTHS');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "accent_font" VARCHAR(40),
ADD COLUMN     "backup_reminder" "backup_reminder" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "body_font" VARCHAR(40),
ADD COLUMN     "brand_colors" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "brand_voice" VARCHAR(500),
ADD COLUMN     "heading_font" VARCHAR(40),
ADD COLUMN     "logo_dark_url" VARCHAR(2048),
ADD COLUMN     "logo_light_url" VARCHAR(2048);

-- CreateTable
CREATE TABLE "dining_tables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "label" VARCHAR(20) NOT NULL,
    "public_code" VARCHAR(16) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dining_tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_public_code_key" ON "dining_tables"("public_code");

-- CreateIndex
CREATE INDEX "dining_tables_tenant_id_sort_order_idx" ON "dining_tables"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_tenant_id_id_key" ON "dining_tables"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------- DINING_TABLE: one live table per label in a restaurant (archived labels can be reused) ----------
CREATE UNIQUE INDEX "dining_tables_tenant_label_live_key" ON "dining_tables"("tenant_id", lower("label")) WHERE "archived_at" IS NULL;
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_public_code_check" CHECK ("public_code" ~ '^[a-z0-9]{8,16}$');

-- ---------- AUDIT_LOG: append-only, with one owner-approved exception (RASOIOS-ADR-021) ----------
-- Rows stay immutable: UPDATE and TRUNCATE are always refused. A DELETE is allowed only inside a transaction that
-- the data-retention service has scoped with SET LOCAL-style settings to one tenant and a cutoff instant, only for that
-- tenant's rows older than the cutoff, and never for a `data.*` row — the record of exports, imports and deletions is
-- permanent. The service only opens that scope after verifying a backup of the same range was taken.
CREATE OR REPLACE FUNCTION "audit_logs_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD."tenant_id" IS NOT NULL
     AND OLD."tenant_id"::text = NULLIF(current_setting('rasoi.audit_purge_tenant', true), '')
     AND OLD."created_at" < NULLIF(current_setting('rasoi.audit_purge_before', true), '')::timestamptz
     AND OLD."action" NOT LIKE 'data.%'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
