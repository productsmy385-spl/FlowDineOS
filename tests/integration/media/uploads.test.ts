import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/v1/media/[assetId]/route";
import { POST } from "@/app/api/v1/media/uploads/route";
import { updateMenuItemAction } from "@/app/restaurant/menu/items-actions";
import { updateBrandingAction } from "@/app/restaurant/settings/website-actions";
import { updateWebsiteIdentityAction } from "@/app/restaurant/website/actions";
import { testDb } from "../setup/db";
import { actorState } from "../helpers/actor-state";
import { asAnonymous, asSeedUser, asUninvited, invokeAction, invokeRoute, seedOnce, tenantIdOf, type TenantKey } from "../helpers/actors";
import { RANDOM_UUID, dataOf, errorOf } from "../orders/helpers";

/**
 * S1-P07-T009 / RASOIOS-ADR-017 — RH-MEDIA-01/02 and the image-reference rules on save.
 * TC-SEC-016 (validation and re-encoding), TC-SEC-017 (tenant isolation of image assets), TC-MEDIA-001…006.
 *
 * ImageKit is stubbed at the HTTP boundary: a local server speaks the two endpoints the app uses (upload, delete), and
 * `imageKit()` is pointed at it. lib/media/imagekit.ts runs unchanged; the real ImageKit is never called.
 */

const ENDPOINT = "https://ik.imagekit.io/rasoios_test";
const APP = "http://localhost:3000";

type StubUpload = { folder: string; fileName: string; bytes: Buffer; flags: Record<string, string> };
const stub = {
  server: null as Server | null,
  url: "",
  uploads: [] as StubUpload[],
  deletes: [] as string[],
  failNextUpload: false,
  counter: 0,
};

vi.mock("@/lib/media/imagekit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/imagekit")>();
  return {
    ...actual,
    imageKit: () => {
      if (!stub.url) throw new Error("ImageKit stub is not listening");
      return actual.createImageKit({ privateKey: "private_test_key", urlEndpoint: ENDPOINT, uploadApiUrl: `${stub.url}/api/v1/files/upload`, mediaApiUrl: `${stub.url}/v1/files`, timeoutMs: 5000 });
    },
  };
});

const db = testDb();

beforeAll(async () => {
  await seedOnce();
  stub.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      if (req.headers.authorization !== `Basic ${Buffer.from("private_test_key:").toString("base64")}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/files/upload") {
        if (stub.failNextUpload) {
          stub.failNextUpload = false;
          res.writeHead(500).end();
          return;
        }
        const form = await new Request("http://stub/", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: Buffer.concat(chunks) }).formData();
        const file = form.get("file") as File;
        const folder = String(form.get("folder"));
        const fileName = String(form.get("fileName"));
        const flags = Object.fromEntries(["useUniqueFileName", "overwriteFile", "isPrivateFile"].map((key) => [key, String(form.get(key))]));
        stub.uploads.push({ folder, fileName, bytes: Buffer.from(await file.arrayBuffer()), flags });
        const filePath = `${folder}/${fileName}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ fileId: `file_${++stub.counter}`, name: fileName, filePath, url: `${ENDPOINT}${filePath}`, width: 64, height: 48, size: file.size }));
        return;
      }
      const deleteMatch = req.url?.match(/^\/v1\/files\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        stub.deletes.push(decodeURIComponent(deleteMatch[1]));
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => stub.server!.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => stub.server?.close(() => resolve()));
});

const imageColumns = { logoUrl: null, coverImageUrl: null, heroImageUrl: null, faviconUrl: null };

beforeEach(async () => {
  vi.stubEnv("IMAGEKIT_PRIVATE_KEY", "private_test_key");
  vi.stubEnv("IMAGEKIT_URL_ENDPOINT", ENDPOINT);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
  stub.uploads = [];
  stub.deletes = [];
  stub.failNextUpload = false;
  await db.rateLimitBucket.deleteMany();
});

afterEach(async () => {
  // Image columns first (they reference assets by URL), then the assets themselves.
  await db.restaurant.updateMany({ where: { tenantId: { in: [tenantIdOf("A"), tenantIdOf("B")] } }, data: imageColumns });
  await db.menuItem.updateMany({ where: { tenantId: { in: [tenantIdOf("A"), tenantIdOf("B")] } }, data: { imageUrl: null } });
  await db.mediaAsset.deleteMany();
});

// ─── Fixtures ───

async function jpeg(options: { width?: number; height?: number; exifArtist?: string } = {}): Promise<Buffer> {
  let image = sharp({ create: { width: options.width ?? 64, height: options.height ?? 48, channels: 3, background: "#c0392b" } }).jpeg();
  if (options.exifArtist) image = image.withExif({ IFD0: { Artist: options.exifArtist } });
  return image.toBuffer();
}

type UploadOptions = { purpose?: string | null; bytes?: Buffer; name?: string; type?: string; origin?: string | null; site?: string | null; extra?: Record<string, string> };

/** POST /api/v1/media/uploads as the current actor, with a real multipart body. */
async function upload(options: UploadOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  if (options.purpose !== null) form.append("purpose", options.purpose ?? "LOGO");
  const bytes = options.bytes ?? (await jpeg());
  form.append("file", new File([new Uint8Array(bytes)], options.name ?? "photo.jpg", { type: options.type ?? "image/jpeg" }));
  for (const [key, value] of Object.entries(options.extra ?? {})) form.append(key, value);
  const headers: Record<string, string> = { "x-request-id": actorState.requestId };
  if (options.origin !== null) headers.origin = options.origin ?? APP;
  if (options.site !== null) headers["sec-fetch-site"] = options.site ?? "same-origin";
  const response = await POST(new NextRequest(`${APP}/api/v1/media/uploads`, { method: "POST", headers, body: form }), undefined as never);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type AssetBody = { asset: { id: string; url: string; purpose: string; width: number; height: number } };
const assetOf = (result: { body: Record<string, unknown> }) => (result.body as AssetBody).asset;
const errorCode = (result: { body: Record<string, unknown> }) => (result.body.error as { code: string }).code;

function discard(assetId: string, origin: string = APP) {
  return invokeRoute(DELETE as never, { method: "DELETE", url: `/api/v1/media/${assetId}`, params: { assetId }, headers: { origin, "sec-fetch-site": "same-origin" } });
}

async function uploadAs(tenant: TenantKey, purpose = "LOGO") {
  await asSeedUser(tenant, "TENANT_ADMIN");
  const result = await upload({ purpose });
  expect(result.status).toBe(201);
  return assetOf(result);
}

// ─── RH-MEDIA-01 ───

describe("TC-MEDIA-001 upload stores the file in ImageKit, then the reference", () => {
  it("returns 201 only after ImageKit accepted the file; the row, the folder and the audit all name the caller's tenant", async () => {
    const { userId } = await asSeedUser("A", "TENANT_ADMIN");
    const result = await upload({ purpose: "LOGO", name: "../../other-tenant/logo.jpg" });
    expect(result.status).toBe(201);
    const asset = assetOf(result);

    expect(stub.uploads).toHaveLength(1);
    const sent = stub.uploads[0];
    expect(sent.folder).toBe(`/rasoios/restaurants/${tenantIdOf("A")}/logo`);
    expect(sent.fileName).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(sent.flags).toEqual({ useUniqueFileName: "false", overwriteFile: "false", isPrivateFile: "false" });

    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row).toMatchObject({
      tenantId: tenantIdOf("A"),
      purpose: "LOGO",
      status: "READY",
      uploadedByUserId: userId,
      contentType: "image/jpeg",
      url: `${ENDPOINT}${sent.folder}/${sent.fileName}`,
      originalFilename: "logo.jpg",
      width: 64,
      height: 48,
    });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

    const audits = await db.auditLog.findMany({ where: { action: "media.uploaded", resourceId: asset.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].tenantId).toBe(tenantIdOf("A"));
  });

  it("TC-SEC-016 re-encodes before upload: EXIF is gone, the image still decodes", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const original = await jpeg({ exifArtist: "Home address of the owner" });
    expect((await sharp(original).metadata()).exif).toBeDefined();

    expect((await upload({ bytes: original })).status).toBe(201);
    const stored = stub.uploads[0].bytes;
    const metadata = await sharp(stored).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(stored.includes(Buffer.from("Home address"))).toBe(false);
  });

  it("caps the longest side at 4096 px", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const wide = await sharp({ create: { width: 5000, height: 100, channels: 3, background: "#000" } }).png().toBuffer();
    expect((await upload({ bytes: wide, name: "wide.png", type: "image/png" })).status).toBe(201);
    const metadata = await sharp(stub.uploads[0].bytes).metadata();
    expect(metadata.width).toBe(4096);
  });
});

describe("TC-SEC-016 invalid files are refused before anything is stored", () => {
  it.each([
    ["an SVG (can carry script)", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "logo.svg", "image/svg+xml", "UNSUPPORTED_IMAGE_TYPE"],
    ["a GIF", Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;"), "a.gif", "image/gif", "UNSUPPORTED_IMAGE_TYPE"],
    ["an executable renamed .jpg", Buffer.from("MZ\u0090\u0000\u0003\u0000\u0000\u0000"), "photo.jpg", "image/jpeg", "UNSUPPORTED_IMAGE_TYPE"],
    ["a JPEG header followed by a script (polyglot)", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("<script>alert(1)</script>")]), "p.jpg", "image/jpeg", "INVALID_IMAGE"],
    ["an empty file", Buffer.alloc(0), "empty.jpg", "image/jpeg", "INVALID_IMAGE"],
  ])("%s → 422", async (_label, bytes, name, type, code) => {
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await upload({ bytes, name, type });
    expect(result.status).toBe(422);
    expect(errorCode(result)).toBe(code);
    expect(stub.uploads).toHaveLength(0);
    expect(await db.mediaAsset.count()).toBe(0);
  });

  it("a file over 5 MB → 422 IMAGE_TOO_LARGE, and the body is not read past the cap", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024 + 100 * 1024)]);
    const result = await upload({ bytes: big });
    expect(result.status).toBe(422);
    expect(errorCode(result)).toBe("IMAGE_TOO_LARGE");
    expect(stub.uploads).toHaveLength(0);
  });

  it("a tiny image (under 16 px) → 422 IMAGE_TOO_SMALL", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await upload({ bytes: await jpeg({ width: 8, height: 8 }) });
    expect(result.status).toBe(422);
    expect(errorCode(result)).toBe("IMAGE_TOO_SMALL");
  });

  it("an unknown purpose, a missing purpose or any extra field (e.g. tenantId, folder) → 422", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    for (const options of [{ purpose: "PRIVATE_DOCUMENT" }, { purpose: null }, { extra: { tenantId: tenantIdOf("B") } }, { extra: { folder: "/rasoios/restaurants/x" } }] as UploadOptions[]) {
      const result = await upload(options);
      expect(result.status, JSON.stringify(options)).toBe(422);
    }
    expect(stub.uploads).toHaveLength(0);
  });
});

describe("TC-MEDIA-002 authentication, role and origin", () => {
  it("anonymous → 401, uninvited → 403; nothing reaches ImageKit", async () => {
    asAnonymous();
    expect((await upload()).status).toBe(401);
    asUninvited();
    expect((await upload()).status).toBe(403);
    expect(stub.uploads).toHaveLength(0);
  });

  it("website images need website:update (TENANT_ADMIN), menu images need menu:manage (TENANT_ADMIN, MANAGER)", async () => {
    const cases: Array<[Parameters<typeof asSeedUser>[1], string, number]> = [
      ["MANAGER", "LOGO", 403],
      ["MANAGER", "HERO", 403],
      ["MANAGER", "MENU_ITEM", 201],
      ["CASHIER", "MENU_ITEM", 403],
      ["WAITER", "MENU_ITEM", 403],
      ["KITCHEN", "MENU_ITEM", 403],
      ["TENANT_ADMIN", "WEBSITE_SECTION", 201],
    ];
    for (const [role, purpose, status] of cases) {
      await asSeedUser("A", role);
      expect((await upload({ purpose })).status, `${role} ${purpose}`).toBe(status);
    }
    expect(stub.uploads).toHaveLength(2);
  });

  it("SC-CSRF-02: a cross-site or origin-less request → 403 before the body is read", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await upload({ origin: "https://evil.example" })).status).toBe(403);
    expect((await upload({ origin: null })).status).toBe(403);
    expect((await upload({ site: "cross-site" })).status).toBe(403);
    expect(stub.uploads).toHaveLength(0);
  });
});

describe("TC-MEDIA-003 ImageKit failures and configuration", () => {
  it("ImageKit refuses the file → 502 UPLOAD_FAILED and no row is written", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    stub.failNextUpload = true;
    const result = await upload();
    expect(result.status).toBe(502);
    expect(errorCode(result)).toBe("UPLOAD_FAILED");
    expect(await db.mediaAsset.count()).toBe(0);
  });

  it("uploads not configured → 503 UPLOADS_DISABLED", async () => {
    vi.stubEnv("IMAGEKIT_PRIVATE_KEY", "");
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await upload();
    expect(result.status).toBe(503);
    expect(errorCode(result)).toBe("UPLOADS_DISABLED");
  });
});

// ─── Using an uploaded image (SC-FILE-02) ───

describe("TC-SEC-017 an image can only be used by the tenant that uploaded it", () => {
  it("Tenant A saves its own upload as logo; Tenant B cannot save Tenant A's URL, and nothing changes for B", async () => {
    const asset = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: asset.url }));
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: tenantIdOf("A") } })).logoUrl).toBe(asset.url);

    await asSeedUser("B", "TENANT_ADMIN");
    const error = errorOf(await invokeAction(updateBrandingAction, { logoUrl: asset.url }));
    expect(error.code).toBe("IMAGE_NOT_OWNED");
    expect(error.fieldErrors?.logoUrl).toBeDefined();
    const heroError = errorOf(await invokeAction(updateWebsiteIdentityAction, { heroImageUrl: asset.url }));
    expect(heroError.code).toBe("IMAGE_NOT_OWNED");
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: tenantIdOf("B") } })).logoUrl).toBeNull();
  });

  it("a URL from another ImageKit account on the shared host is refused, as is an unknown file under our endpoint", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    for (const url of ["https://ik.imagekit.io/someone_else/photo.jpg", `${ENDPOINT}/rasoios/restaurants/${tenantIdOf("A")}/logo/never-uploaded.jpg`]) {
      const error = errorOf(await invokeAction(updateBrandingAction, { logoUrl: url }));
      expect(error.code, url).toBe("IMAGE_NOT_OWNED");
    }
  });

  it("Tenant B cannot put Tenant A's upload on a menu item", async () => {
    const asset = await uploadAs("A", "MENU_ITEM");
    await asSeedUser("B", "TENANT_ADMIN");
    const item = await db.menuItem.findFirstOrThrow({ where: { tenantId: tenantIdOf("B"), archivedAt: null } });
    const error = errorOf(await invokeAction(updateMenuItemAction, { itemId: item.id, expectedUpdatedAt: item.updatedAt.toISOString(), imageUrl: asset.url }));
    expect(error.code).toBe("IMAGE_NOT_OWNED");
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: item.id } })).imageUrl).toBeNull();
  });
});

describe("TC-MEDIA-004 replacing an image releases the old one after the save", () => {
  it("the replaced logo is marked DELETED (audited) and removed from ImageKit; the new one stays", async () => {
    const first = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: first.url }));
    const second = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: second.url }));

    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("DELETED");
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("READY");
    const firstRow = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.id } });
    expect(stub.deletes).toEqual([firstRow.providerFileId]);
    expect(await db.auditLog.count({ where: { action: "media.deleted", resourceId: first.id } })).toBe(1);
  });

  it("an image still used by another field is kept", async () => {
    const shared = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: shared.url, coverImageUrl: shared.url }));
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: null }));
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: shared.id } })).status).toBe("READY");
    expect(stub.deletes).toEqual([]);
  });
});

// ─── RH-MEDIA-02 ───

describe("TC-MEDIA-005 discarding an upload", () => {
  it("the uploader's tenant can discard an unused upload: row DELETED, file removed", async () => {
    const asset = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await discard(asset.id);
    expect(result.status).toBe(200);
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("DELETED");
    expect(stub.deletes).toHaveLength(1);
  });

  it("Tenant B gets the same 404 for Tenant A's asset as for a random id, and A's asset is untouched", async () => {
    const asset = await uploadAs("A");
    await asSeedUser("B", "TENANT_ADMIN");
    const foreign = await discard(asset.id);
    const random = await discard(RANDOM_UUID);
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect((foreign.body as { error: { message: string } }).error.message).toBe((random.body as { error: { message: string } }).error.message);
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("READY");
    expect(stub.deletes).toHaveLength(0);
  });

  it("an image in use → 409 IMAGE_IN_USE; a MANAGER cannot discard a website image (403); cross-site → 403", async () => {
    const asset = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: asset.url }));
    const inUse = await discard(asset.id);
    expect(inUse.status).toBe(409);
    expect((inUse.body as { error: { code: string } }).error.code).toBe("IMAGE_IN_USE");

    const unused = await uploadAs("A");
    await asSeedUser("A", "MANAGER");
    expect((await discard(unused.id)).status).toBe(403);
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await discard(unused.id, "https://evil.example")).status).toBe(403);
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: unused.id } })).status).toBe("READY");
  });

  it("a malformed id → 422", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await discard("not-a-uuid")).status).toBe(422);
  });
});

describe("TC-MEDIA-006 abandoned uploads are cleaned up", () => {
  it("an upload never used for over a day is deleted by the tenant's next upload; used and recent ones stay", async () => {
    const abandoned = await uploadAs("A");
    const used = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: used.url }));
    const otherTenant = await uploadAs("B");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.mediaAsset.updateMany({ where: { id: { in: [abandoned.id, used.id, otherTenant.id] } }, data: { createdAt: old } });

    await uploadAs("A");
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe("DELETED");
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: used.id } })).status).toBe("READY");
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: otherTenant.id } })).status).toBe("READY");
  });
});

describe("TC-MEDIA-007 the editor saves a logo the moment it is uploaded or removed (owner report 2026-10-07)", () => {
  it("replace then remove, sent as the editor sends them, keeps the saved cover and records each save", async () => {
    const cover = await uploadAs("A", "COVER");
    const first = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(updateBrandingAction, { logoUrl: first.url, coverImageUrl: cover.url }));
    const auditsBefore = await db.auditLog.count({ where: { tenantId: tenantIdOf("A"), action: "restaurant.branding_updated" } });

    // Replace: the new logo, with the cover's saved value.
    const second = await uploadAs("A");
    await asSeedUser("A", "TENANT_ADMIN");
    const replaced = dataOf(await invokeAction(updateBrandingAction, { logoUrl: second.url, coverImageUrl: cover.url })) as { logoUrl: string | null; coverImageUrl: string | null };
    expect(replaced).toMatchObject({ logoUrl: second.url, coverImageUrl: cover.url });

    // Remove: an empty logo clears it; the cover stays.
    const removed = dataOf(await invokeAction(updateBrandingAction, { logoUrl: "", coverImageUrl: cover.url })) as { logoUrl: string | null; coverImageUrl: string | null };
    expect(removed).toMatchObject({ logoUrl: null, coverImageUrl: cover.url });
    const restaurant = await db.restaurant.findUniqueOrThrow({ where: { tenantId: tenantIdOf("A") } });
    expect(restaurant.logoUrl).toBeNull();
    expect(restaurant.coverImageUrl).toBe(cover.url);
    expect(await db.auditLog.count({ where: { tenantId: tenantIdOf("A"), action: "restaurant.branding_updated" } })).toBe(auditsBefore + 2);
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("DELETED"); // released once unused
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: cover.id } })).status).toBe("READY");
  });
});
