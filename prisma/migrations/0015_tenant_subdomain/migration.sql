-- Tenant subdomain alias (FlowDineOS wildcard hostname routing)
-- Adds optional, unique subdomain to tenants table.
-- Existing tenant slug references and paths are preserved.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "subdomain" VARCHAR(48);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain");

-- Assign Akshayapatra-Devarapalli's public subdomain
UPDATE "tenants"
SET "subdomain" = 'akshayapatra'
WHERE "slug" = 'akshayapatra-devarapalli';
