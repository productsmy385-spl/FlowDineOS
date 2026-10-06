"use client";

import * as React from "react";
import { Copy, Download, Facebook, Instagram, MessageCircle, Share2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/ui/cn";

/**
 * Sharing from the public website (owner review 2026-10-06 §12–13).
 *
 * Everything here hands the guest's own app the text and link — the site never posts anywhere and never claims it did.
 * - "Share…" uses the browser's share sheet where it exists (most phones);
 * - WhatsApp and Facebook open their own share pages with the text and link filled in;
 * - Instagram has no way for a website to post on someone's behalf, so it offers the honest workflow instead: copy the
 *   caption, save the picture, then post it from the Instagram app;
 * - "Copy link" copies the restaurant's address. No internal id ever appears in a link.
 */

export type ShareContent = {
  /** What is being shared, for the dialog title: the restaurant or one dish. */
  title: string;
  /** The ready-made caption, e.g. "Try our Gulab Jamun at Akshayapatra\n₹60". The link is added after it. */
  text: string;
  /** Absolute link; when the site has no canonical address, the current page's own address is used. */
  url: string | null;
  /** A picture to save for Instagram: the dish photo, or the site's social preview image. */
  imageUrl: string | null;
};

function absolute(url: string | null): string {
  if (url) return url;
  return typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}`;
}

export function ShareButton({ content, className, label = "Share", compact = false }: { content: ShareContent; className?: string; label?: string; compact?: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={compact ? `${label}: ${content.title}` : undefined}
        className={cn(
          "inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-border-strong px-3 text-nav text-fg-primary transition-colors duration-fast hover:bg-raised",
          className,
        )}
      >
        <Share2 aria-hidden className="size-4" />
        {compact ? null : label}
      </button>
      <ShareDialog open={open} onClose={() => setOpen(false)} content={content} />
    </>
  );
}

function ShareDialog({ open, onClose, content }: { open: boolean; onClose: () => void; content: ShareContent }) {
  const [status, setStatus] = React.useState<string | null>(null);
  const [canNativeShare, setCanNativeShare] = React.useState(false);
  React.useEffect(() => {
    setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    if (open) setStatus(null);
  }, [open]);

  const url = absolute(content.url);
  const caption = `${content.text}\n${url}`;

  const copy = async (value: string, done: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(done);
    } catch {
      setStatus("Your browser did not allow copying. Select the text below and copy it yourself.");
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: content.title, text: content.text, url });
      onClose();
    } catch {
      // The guest closed the share sheet: nothing was shared, and nothing is claimed.
    }
  };

  const saveImage = async () => {
    if (!content.imageUrl) return;
    try {
      const response = await fetch(content.imageUrl, { mode: "cors" });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${content.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "menu"}.${blob.type.includes("png") ? "png" : "jpg"}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setStatus("Picture saved. Open Instagram, create a post with it and paste the caption.");
    } catch {
      window.open(content.imageUrl, "_blank", "noopener,noreferrer");
      setStatus("The picture opened in a new tab — save it from there, then post it from Instagram with the caption.");
    }
  };

  const option = "flex min-h-12 w-full items-center gap-3 rounded-xl border border-border-strong bg-card px-4 text-left text-body text-fg-primary hover:bg-raised";

  return (
    <Dialog open={open} onClose={onClose} title={`Share ${content.title}`} size="confirm" guardDirty={false}>
      <div className="flex flex-col gap-2">
        {canNativeShare && (
          <button type="button" className={option} onClick={nativeShare}>
            <Share2 aria-hidden className="size-5" /> Share…
          </button>
        )}
        <a className={option} href={`https://wa.me/?text=${encodeURIComponent(caption)}`} target="_blank" rel="noopener noreferrer">
          <MessageCircle aria-hidden className="size-5" /> WhatsApp
        </a>
        <a className={option} href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">
          <Facebook aria-hidden className="size-5" /> Facebook
        </a>
        <button type="button" className={option} onClick={() => copy(url, "Link copied.")}>
          <Copy aria-hidden className="size-5" /> Copy link
        </button>
        <div className="flex flex-col gap-2 rounded-xl border border-border-subtle p-3">
          <p className="flex items-center gap-2 text-label text-fg-primary">
            <Instagram aria-hidden className="size-5" /> Instagram
          </p>
          <p className="text-caption text-fg-secondary">Instagram only lets you post from its own app. Copy the caption and save the picture, then post them there.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl border border-border-strong px-3 text-label text-fg-primary hover:bg-raised" onClick={() => copy(caption, "Caption copied. Paste it into your Instagram post.")}>
              <Copy aria-hidden className="size-4" /> Copy caption
            </button>
            {content.imageUrl && (
              <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl border border-border-strong px-3 text-label text-fg-primary hover:bg-raised" onClick={saveImage}>
                <Download aria-hidden className="size-4" /> Save picture
              </button>
            )}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-caption text-fg-secondary">
          Caption
          <textarea readOnly value={caption} rows={3} className="w-full rounded-xl border border-border-strong bg-canvas p-2 text-body text-fg-primary" onFocus={(event) => event.currentTarget.select()} />
        </label>
        {status && (
          <p role="status" className="text-body text-status-success">
            {status}
          </p>
        )}
      </div>
    </Dialog>
  );
}
