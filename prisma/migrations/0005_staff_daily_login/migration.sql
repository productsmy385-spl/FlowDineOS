-- CreateEnum
CREATE TYPE "staff_credential_status" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "staff_session_status" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "staff_session_end_reason" AS ENUM ('SIGNED_OUT', 'ADMIN_FORCE_LOGOUT', 'CREDENTIAL_REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "staff_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "business_date" DATE NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "staff_credential_status" NOT NULL DEFAULT 'ACTIVE',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "generated_by_user_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "role" "tenant_role" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "status" "staff_session_status" NOT NULL DEFAULT 'ACTIVE',
    "end_reason" "staff_session_end_reason",
    "business_date" DATE NOT NULL,
    "login_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "ended_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_credentials_tenant_id_membership_id_status_idx" ON "staff_credentials"("tenant_id", "membership_id", "status");

-- CreateIndex
CREATE INDEX "staff_credentials_tenant_id_business_date_idx" ON "staff_credentials"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_credentials_tenant_id_id_key" ON "staff_credentials"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_sessions_token_hash_key" ON "staff_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "staff_sessions_tenant_id_status_membership_id_idx" ON "staff_sessions"("tenant_id", "status", "membership_id");

-- CreateIndex
CREATE INDEX "staff_sessions_tenant_id_business_date_idx" ON "staff_sessions"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_sessions_tenant_id_id_key" ON "staff_sessions"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "user_tenants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_generated_by_user_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "user_tenants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_tenant_id_credential_id_fkey" FOREIGN KEY ("tenant_id", "credential_id") REFERENCES "staff_credentials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_ended_by_user_id_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one ACTIVE credential per membership. Regenerating therefore *cannot* leave yesterday's password working:
-- the database refuses a second live one, rather than the service having to remember to revoke the old row
-- (ADR-019 §3, C14).
CREATE UNIQUE INDEX "staff_credentials_one_active_per_membership"
  ON "staff_credentials" ("tenant_id", "membership_id")
  WHERE "status" = 'ACTIVE';

-- One live session per membership, for the same reason: a second device cannot silently fork a shift, and
-- attendance stays a clean sequence of sessions (ADR-019 §4).
CREATE UNIQUE INDEX "staff_sessions_one_active_per_membership"
  ON "staff_sessions" ("tenant_id", "membership_id")
  WHERE "status" = 'ACTIVE';

-- Invariants the application also enforces (ADR-019, SC-STAFF-01..04).
ALTER TABLE "staff_credentials"
  ADD CONSTRAINT "staff_credentials_expires_after_creation_check" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "staff_credentials_revoked_at_check" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL)),
  ADD CONSTRAINT "staff_credentials_failed_attempts_check" CHECK ("failed_attempts" >= 0),
  -- A password hash is scrypt in our own encoding; a bare or plaintext-looking value must never reach this column.
  ADD CONSTRAINT "staff_credentials_password_hash_check" CHECK ("password_hash" LIKE 'scrypt$%');

ALTER TABLE "staff_sessions"
  ADD CONSTRAINT "staff_sessions_ended_at_check" CHECK (("status" = 'ENDED') = ("ended_at" IS NOT NULL)),
  ADD CONSTRAINT "staff_sessions_end_reason_check" CHECK (("status" = 'ENDED') = ("end_reason" IS NOT NULL)),
  ADD CONSTRAINT "staff_sessions_expires_after_login_check" CHECK ("expires_at" > "login_at"),
  ADD CONSTRAINT "staff_sessions_ended_after_login_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "login_at"),
  -- Only staff roles ever get a daily-password session. TENANT_ADMIN and MANAGER keep Clerk (ADR-019 §1, C7).
  ADD CONSTRAINT "staff_sessions_role_is_staff_check" CHECK ("role" IN ('CASHIER', 'KITCHEN', 'WAITER'));
