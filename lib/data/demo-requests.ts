import "server-only";
import type { DemoRequestStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db/prisma";
import type { Tx } from "./tx";

/**
 * Demo requests (RASOIOS-ADR-024). Platform data with no tenant: written by the public form, read and updated only by
 * the platform owner through `platform:demo_request:*`.
 */

export type DemoRequestRow = {
  id: string;
  name: string;
  businessName: string;
  phone: string;
  email: string;
  city: string;
  preferredDate: string;
  preferredTime: string;
  outletCount: number | null;
  message: string | null;
  status: DemoRequestStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

const SELECT = {
  id: true,
  name: true,
  businessName: true,
  phone: true,
  email: true,
  city: true,
  preferredDate: true,
  preferredTime: true,
  outletCount: true,
  message: true,
  status: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DemoRequestSelect;

type Row = Prisma.DemoRequestGetPayload<{ select: typeof SELECT }>;

const toDto = (row: Row): DemoRequestRow => ({
  ...row,
  preferredDate: row.preferredDate.toISOString().slice(0, 10),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function insertDemoRequest(tx: Tx, data: Omit<Prisma.DemoRequestCreateInput, "status" | "notes" | "updatedBy">): Promise<DemoRequestRow> {
  return toDto(await tx.demoRequest.create({ data, select: SELECT }));
}

export async function listDemoRequests(filter: { status?: DemoRequestStatus }, take = 200): Promise<DemoRequestRow[]> {
  const rows = await db.demoRequest.findMany({ where: filter.status ? { status: filter.status } : {}, orderBy: { createdAt: "desc" }, take, select: SELECT });
  return rows.map(toDto);
}

export async function countDemoRequestsByStatus(): Promise<Record<string, number>> {
  const rows = await db.demoRequest.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}

export async function findDemoRequest(tx: Tx, id: string): Promise<DemoRequestRow | null> {
  const row = await tx.demoRequest.findUnique({ where: { id }, select: SELECT });
  return row ? toDto(row) : null;
}

export async function updateDemoRequestRow(tx: Tx, id: string, data: { status?: DemoRequestStatus; notes?: string | null; updatedByUserId: string }): Promise<DemoRequestRow> {
  return toDto(await tx.demoRequest.update({ where: { id }, data, select: SELECT }));
}
