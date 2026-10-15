import "server-only";
import { randomUUID } from "node:crypto";
import type { MediaPurpose } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { db } from "@/lib/db/prisma";
import { instantDto } from "./dto";
import { mapErrors } from "./errors";
import { tenantKey, tenantScope } from "./scope";
import { withTx, type Tx } from "./tx";

/**
 * Media asset data (E28, RASOIOS-ADR-017; api.md RH-MEDIA-01/02).
 *
 * Every read and write is addressed by `tenant_id = ctx.tenantId`; an asset id or URL from input is only ever looked up
 * inside the caller's tenant, so another tenant's asset behaves exactly like one that does not exist (SC-FILE-02).
 * Rows are written only after ImageKit has stored the file. Each insert and each deletion commits with its audit row.
 */

const RESOURCE = "media_asset";

const ASSET_SELECT = {
  id: true,
  purpose: true,
  url: true,
  width: true,
  height: true,
  contentType: true,
  byteSize: true,
  originalFilename: true,
  providerFileId: true,
  createdAt: true,
} as const;

export type MediaAssetDto = {
  id: string;
  purpose: MediaPurpose;
  url: string;
  width: number;
  height: number;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdAt: string;
};

type AssetRow = { id: string; purpose: MediaPurpose; url: string; width: number; height: number; contentType: string; byteSize: number; originalFilename: string | null; providerFileId: string; createdAt: Date };

function toDto(row: AssetRow): MediaAssetDto {
  return {
    id: row.id,
    purpose: row.purpose,
    url: row.url,
    width: row.width,
    height: row.height,
    contentType: row.contentType,
    byteSize: row.byteSize,
    originalFilename: row.originalFilename,
    createdAt: instantDto(row.createdAt),
  };
}

export type NewMediaAsset = {
  purpose: MediaPurpose;
  providerFileId: string;
  storagePath: string;
  url: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  originalFilename: string | null;
};

/** Helper to expand URLs to test both encoded and decoded variants (e.g. KRANAS%20LOGO.png vs KRANAS LOGO.png). */
export function expandUrlVariants(urls: readonly string[]): string[] {
  const result = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    result.add(u);
    try {
      result.add(decodeURI(u));
      result.add(encodeURI(decodeURI(u)));
    } catch {
      // ignore malformed URI
    }
  }
  return [...result];
}

/** `media.uploaded` — the uploader is always the signed-in user, never an input field. */
export async function insertMediaAsset(ctx: TenantContext, input: NewMediaAsset): Promise<MediaAssetDto> {
  return withTx(ctx, async (tx) => {
    const row = await tx.mediaAsset.create({
      data: { ...input, tenantId: ctx.tenantId, uploadedByUserId: ctx.userId },
      select: ASSET_SELECT,
    });
    await audit(tx, ctx, {
      action: "media.uploaded",
      resourceType: RESOURCE,
      resourceId: row.id,
      after: { purpose: row.purpose, url: row.url, contentType: row.contentType, byteSize: row.byteSize, width: row.width, height: row.height },
    });
    return toDto(row);
  });
}

/** READY assets of this tenant whose untransformed URL is one of `urls`. Also reactivates DELETED assets if re-selected. */
export async function findReadyAssetsByUrl(ctx: TenantContext, urls: readonly string[]): Promise<Array<{ id: string; url: string; purpose: MediaPurpose }>> {
  if (urls.length === 0) return [];
  const expanded = expandUrlVariants(urls);
  return mapErrors("Image", async () => {
    // 1. Check for ready assets
    const ready = await db.mediaAsset.findMany({
      where: tenantScope(ctx, { url: { in: expanded }, status: "READY" as const }),
      select: { id: true, url: true, purpose: true },
    });
    if (ready.length > 0) return ready;

    // 2. If this tenant previously had this asset marked DELETED, reactivate it to READY
    const deleted = await db.mediaAsset.findMany({
      where: tenantScope(ctx, { url: { in: expanded }, status: "DELETED" as const }),
      select: { id: true, url: true, purpose: true },
    });
    if (deleted.length > 0) {
      await db.mediaAsset.updateMany({
        where: tenantScope(ctx, { id: { in: deleted.map((d) => d.id) } }),
        data: { status: "READY", deletedAt: null },
      });
      return deleted;
    }
    return [];
  });
}

/** Check if any of these URLs are registered in media_assets as owned by ANOTHER tenant. */
export async function isAssetOwnedByOtherTenant(ctx: TenantContext, urls: readonly string[]): Promise<boolean> {
  if (urls.length === 0) return false;
  const expanded = expandUrlVariants(urls);
  return mapErrors("Image", async () => {
    const count = await db.mediaAsset.count({
      where: {
        url: { in: expanded },
        tenantId: { not: ctx.tenantId },
      },
    });
    return count > 0;
  });
}

/** All image URLs currently assigned to this tenant across restaurant, website sections, and menu items. */
export async function findTenantCurrentAssetUrls(ctx: TenantContext): Promise<Set<string>> {
  return mapErrors("Image", async () => {
    const [restaurant, sections, items] = await Promise.all([
      db.restaurant.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { logoUrl: true, coverImageUrl: true, heroImageUrl: true, faviconUrl: true },
      }),
      db.websiteSection.findMany({
        where: tenantScope(ctx, { imageUrl: { not: null } }),
        select: { imageUrl: true },
      }),
      db.menuItem.findMany({
        where: tenantScope(ctx, { imageUrl: { not: null } }),
        select: { imageUrl: true },
      }),
    ]);

    const rawUrls: string[] = [];
    if (restaurant) {
      if (restaurant.logoUrl) rawUrls.push(restaurant.logoUrl);
      if (restaurant.coverImageUrl) rawUrls.push(restaurant.coverImageUrl);
      if (restaurant.heroImageUrl) rawUrls.push(restaurant.heroImageUrl);
      if (restaurant.faviconUrl) rawUrls.push(restaurant.faviconUrl);
    }
    for (const s of sections) {
      if (s.imageUrl) rawUrls.push(s.imageUrl);
    }
    for (const i of items) {
      if (i.imageUrl) rawUrls.push(i.imageUrl);
    }
    return new Set(expandUrlVariants(rawUrls));
  });
}

/** Registers a verified ImageKit URL as a READY media asset for this tenant. */
export async function registerTenantMediaAsset(ctx: TenantContext, input: { url: string; purpose: MediaPurpose }): Promise<MediaAssetDto> {
  const expanded = expandUrlVariants([input.url]);
  return mapErrors("Image", async () => {
    const existing = await db.mediaAsset.findFirst({
      where: tenantScope(ctx, { url: { in: expanded } }),
      select: ASSET_SELECT,
    });
    if (existing) {
      await db.mediaAsset.update({
        where: tenantKey(ctx, existing.id),
        data: { status: "READY", deletedAt: null },
      });
      return toDto(existing as AssetRow);
    }

    let pathname = "/";
    try {
      pathname = new URL(input.url).pathname;
    } catch {
      pathname = `/${input.url}`;
    }
    const filename = pathname.split("/").pop() ?? "image.png";

    return withTx(ctx, async (tx) => {
      const row = await tx.mediaAsset.create({
        data: {
          tenantId: ctx.tenantId,
          uploadedByUserId: ctx.userId,
          purpose: input.purpose,
          status: "READY",
          providerFileId: `legacy-${randomUUID()}`,
          storagePath: pathname,
          url: input.url,
          contentType: input.url.endsWith(".png") ? "image/png" : input.url.endsWith(".webp") ? "image/webp" : "image/jpeg",
          byteSize: 0,
          width: 0,
          height: 0,
          sha256: "",
          originalFilename: filename,
        },
        select: ASSET_SELECT,
      });
      await audit(tx, ctx, {
        action: "media.uploaded",
        resourceType: RESOURCE,
        resourceId: row.id,
        after: { purpose: row.purpose, url: row.url, registered: true },
      });
      return toDto(row as AssetRow);
    });
  });
}

/** READY assets of this tenant with one of these ids (anything else — unknown or another tenant's — is simply absent). */
export async function findReadyAssetsById(ctx: TenantContext, ids: readonly string[]): Promise<Array<{ id: string; url: string; purpose: MediaPurpose }>> {
  if (ids.length === 0) return [];
  return mapErrors("Image", () =>
    db.mediaAsset.findMany({ where: tenantScope(ctx, { id: { in: [...new Set(ids)] }, status: "READY" as const }), select: { id: true, url: true, purpose: true } }),
  );
}

/** Whether any image column of this tenant still points at `url` — archived menu items included, so restoring one never shows a broken image. */
async function isReferenced(tx: Tx, ctx: TenantContext, url: string): Promise<boolean> {
  const [restaurant, section, item] = await Promise.all([
    tx.restaurant.findFirst({
      where: tenantScope(ctx, { OR: [{ logoUrl: url }, { coverImageUrl: url }, { heroImageUrl: url }, { faviconUrl: url }] }),
      select: { id: true },
    }),
    tx.websiteSection.findFirst({ where: tenantScope(ctx, { imageUrl: url }), select: { id: true } }),
    tx.menuItem.findFirst({ where: tenantScope(ctx, { imageUrl: url }), select: { id: true } }),
  ]);
  return restaurant !== null || section !== null || item !== null;
}

export type DeleteOutcome =
  | { outcome: "DELETED"; providerFileId: string }
  | { outcome: "IN_USE" }
  | { outcome: "NOT_FOUND" };

/**
 * `media.deleted` — marks one of this tenant's READY assets DELETED, but only when nothing references it. The row is
 * locked first so a concurrent save cannot start referencing it between the check and the update. The caller removes
 * the file from ImageKit after this commits (ADR-017 §5: the database moves first, the CDN file goes last).
 */
export async function markAssetDeleted(ctx: TenantContext, where: { id: string } | { url: string }, reason: string): Promise<DeleteOutcome> {
  return withTx(ctx, async (tx) => {
    const locked =
      "id" in where
        ? await tx.$queryRaw<Array<{ id: string; url: string; provider_file_id: string }>>`
            SELECT id, url, provider_file_id FROM media_assets
            WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${where.id}::uuid AND status = 'READY'
            FOR UPDATE`
        : await tx.$queryRaw<Array<{ id: string; url: string; provider_file_id: string }>>`
            SELECT id, url, provider_file_id FROM media_assets
            WHERE tenant_id = ${ctx.tenantId}::uuid AND url = ${where.url} AND status = 'READY'
            FOR UPDATE`;
    const asset = locked[0];
    if (!asset) return { outcome: "NOT_FOUND" };
    if (await isReferenced(tx, ctx, asset.url)) return { outcome: "IN_USE" };

    await tx.mediaAsset.update({ where: tenantKey(ctx, asset.id), data: { status: "DELETED", deletedAt: new Date() } });
    await audit(tx, ctx, { action: "media.deleted", resourceType: RESOURCE, resourceId: asset.id, before: { status: "READY", url: asset.url }, after: { status: "DELETED" }, reason });
    return { outcome: "DELETED", providerFileId: asset.provider_file_id };
  });
}

/**
 * Up to `limit` of this tenant's READY assets created before `before` that no image column references — candidates for
 * the abandoned-upload sweep. `markAssetDeleted` re-checks under a row lock, so a race only means a skipped candidate.
 */
export async function unreferencedAssetsCreatedBefore(ctx: TenantContext, before: Date, limit: number): Promise<Array<{ id: string }>> {
  return mapErrors("Image", () =>
    db.$queryRaw<Array<{ id: string }>>`
      SELECT m.id FROM media_assets m
      WHERE m.tenant_id = ${ctx.tenantId}::uuid AND m.status = 'READY' AND m.created_at < ${before}
        AND NOT EXISTS (SELECT 1 FROM restaurants r WHERE r.tenant_id = m.tenant_id
                          AND m.url IN (r.logo_url, r.cover_image_url, r.hero_image_url, r.favicon_url))
        AND NOT EXISTS (SELECT 1 FROM website_sections s WHERE s.tenant_id = m.tenant_id AND s.image_url = m.url)
        AND NOT EXISTS (SELECT 1 FROM menu_items i WHERE i.tenant_id = m.tenant_id AND i.image_url = m.url)
      ORDER BY m.created_at
      LIMIT ${limit}`,
  );
}

/** Image URLs a save is about to overwrite, read before the save so the replaced files can be released after it. */
export type ImageOwner = { kind: "restaurant" } | { kind: "sections" } | { kind: "menu_item"; itemId: string };

export async function currentImageUrls(ctx: TenantContext, owner: ImageOwner): Promise<string[]> {
  return mapErrors("Image", async () => {
    if (owner.kind === "restaurant") {
      const row = await db.restaurant.findFirst({ where: tenantScope(ctx), select: { logoUrl: true, coverImageUrl: true, heroImageUrl: true, faviconUrl: true } });
      return row ? [row.logoUrl, row.coverImageUrl, row.heroImageUrl, row.faviconUrl].filter((url): url is string => url !== null) : [];
    }
    if (owner.kind === "sections") {
      const rows = await db.websiteSection.findMany({ where: tenantScope(ctx, { imageUrl: { not: null } }), select: { imageUrl: true } });
      return rows.map((row) => row.imageUrl).filter((url): url is string => url !== null);
    }
    const item = await db.menuItem.findFirst({ where: tenantScope(ctx, { id: owner.itemId }), select: { imageUrl: true } });
    return item?.imageUrl ? [item.imageUrl] : [];
  });
}
