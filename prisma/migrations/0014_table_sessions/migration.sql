-- Table bills and KOT print choice (RASOIOS-ADR-027, owner brief 2026-10-13).
-- Additive only: two new tables, nullable links on orders and transactions, one defaulted KOT column and one counter
-- value. No existing row is changed: orders placed before this migration keep table_session_id NULL and are billed per
-- order exactly as before; nothing is merged by table label.

-- CreateEnum
CREATE TYPE "table_session_status" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum (not used in this migration, so it is safe inside its transaction)
ALTER TYPE "counter_type" ADD VALUE 'TABLE_BILL';

-- AlterTable: "Send to KOT only" tickets are not printed. Default true = every existing ticket and the current flow.
ALTER TABLE "kot_tickets" ADD COLUMN     "print_requested" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "table_session_id" UUID;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "table_session_payment_id" UUID;

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "table_label" VARCHAR(20) NOT NULL,
    "table_key" VARCHAR(20) NOT NULL,
    "bill_number" VARCHAR(20) NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "table_session_status" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "opened_by_user_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id"),
    -- A closed bill always records when; an open one never has a close time.
    CONSTRAINT "table_sessions_closed_consistent" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "table_session_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "table_session_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "payment_method" "payment_method" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "amount_tendered" DECIMAL(12,2),
    "change_due" DECIMAL(12,2),
    "reference" VARCHAR(64),
    "business_date" DATE NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_session_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "table_session_payments_amount_positive" CHECK ("amount" > 0)
);

-- At most one OPEN bill per table per restaurant. A second order for the same table joins it; two cashiers opening
-- the same table at the same instant cannot both succeed.
CREATE UNIQUE INDEX "table_sessions_open_table_key" ON "table_sessions"("tenant_id", "table_key") WHERE "status" = 'OPEN';

-- CreateIndex
CREATE INDEX "table_sessions_tenant_id_status_idx" ON "table_sessions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "table_sessions_tenant_id_business_date_idx" ON "table_sessions"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "table_sessions_tenant_id_id_key" ON "table_sessions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "table_sessions_tenant_id_bill_number_key" ON "table_sessions"("tenant_id", "bill_number");

-- CreateIndex
CREATE INDEX "table_session_payments_tenant_id_table_session_id_idx" ON "table_session_payments"("tenant_id", "table_session_id");

-- CreateIndex
CREATE INDEX "table_session_payments_tenant_id_business_date_idx" ON "table_session_payments"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "table_session_payments_tenant_id_idempotency_key_key" ON "table_session_payments"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "table_session_payments_tenant_id_id_key" ON "table_session_payments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "orders_tenant_id_table_session_id_idx" ON "orders"("tenant_id", "table_session_id");

-- AddForeignKey: composite (tenant_id, id) keys, so an order can only ever join its own tenant's bill.
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_table_session_id_fkey" FOREIGN KEY ("tenant_id", "table_session_id") REFERENCES "table_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenant_id_table_session_payment_id_fkey" FOREIGN KEY ("tenant_id", "table_session_payment_id") REFERENCES "table_session_payments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_opened_by_user_id_fkey" FOREIGN KEY ("opened_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_session_payments" ADD CONSTRAINT "table_session_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_session_payments" ADD CONSTRAINT "table_session_payments_tenant_id_table_session_id_fkey" FOREIGN KEY ("tenant_id", "table_session_id") REFERENCES "table_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_session_payments" ADD CONSTRAINT "table_session_payments_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
