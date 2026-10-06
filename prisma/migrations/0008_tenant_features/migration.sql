-- CreateTable
CREATE TABLE "tenant_features" (
    "tenant_id" UUID NOT NULL,
    "feature_key" VARCHAR(40) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("tenant_id","feature_key")
);

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Only the features the platform knows (lib/auth/features.ts); a new feature adds its key here in its own migration.
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_feature_key_check"
  CHECK ("feature_key" IN ('ORDERS', 'KITCHEN', 'PRINTING', 'BILLING', 'MENU', 'DAILY_MENU', 'CUSTOMERS', 'REPORTS', 'QR_MENU', 'WEBSITE', 'STAFF', 'SOCIAL', 'DATA'));
