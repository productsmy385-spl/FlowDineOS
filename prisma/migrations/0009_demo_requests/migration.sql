-- CreateEnum
CREATE TYPE "demo_request_status" AS ENUM ('NEW', 'CONTACTED', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "business_name" VARCHAR(160) NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "preferred_date" DATE NOT NULL,
    "preferred_time" VARCHAR(5) NOT NULL,
    "outlet_count" SMALLINT,
    "message" VARCHAR(1000),
    "status" "demo_request_status" NOT NULL DEFAULT 'NEW',
    "notes" VARCHAR(2000),
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demo_requests_status_created_at_idx" ON "demo_requests"("status", "created_at");

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shapes the form already validates, enforced again by the database.
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_phone_check" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_time_check" CHECK ("preferred_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_outlet_count_check" CHECK ("outlet_count" IS NULL OR "outlet_count" BETWEEN 1 AND 999);
