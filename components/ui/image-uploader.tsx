"use client";

import * as React from "react";
import { CircleCheck, ImagePlus, Link2, RefreshCw, Trash2 } from "lucide-react";
import { imageKitSized, type MediaPurpose } from "@/lib/media/purposes";
import { cn } from "@/lib/ui/cn";
import { Button } from "./button";
import { FieldError, FieldHelp, RequiredMark, useFieldWiring } from "./form/form-field";
import { Icon } from "./icon";
import { TextInput } from "./inputs";

/**
 * ImageUploader (S1-P07-T009, RASOIOS-ADR-017; design.md §8 Forms). Picks or drops a JPG/PNG/WebP, sends it to
 * `POST /api/v1/media/uploads`, and only reports success — and only hands the URL to the form — after the server
 * answered 201, i.e. after ImageKit stored it and the asset row committed. The form then saves the URL as before.
 *
 * - Browser checks (type, 5 MB) are a courtesy; the server re-checks the bytes and re-encodes (SC-FILE-01).
 * - An upload made here and then replaced or removed before the form was saved is discarded right away
 *   (`DELETE /api/v1/media/{id}`); an image that was already saved is released by the server after the next save.
 * - "Use an image link" keeps the allow-listed URL field for images hosted elsewhere.
 * - Status changes are announced through a polite live region.
 */

export type UploadState = "IDLE" | "SELECTED" | "VALIDATING" | "UPLOADING" | "PROCESSING" | "UPLOADED" | "FAILED" | "REMOVING";

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

export type ImageUploaderProps = {
  label: string;
  purpose: MediaPurpose;
  /** The current image URL ("" for none). */
  value: string;
  onChange: (url: string) => void;
  /**
   * Called once a new image has finished uploading, or the image was removed — never while a link is being typed.
   * Give it to save straight away (the logo and cover do, owner report 2026-10-07); without it the form's own Save
   * button applies the change.
   */
  onCommit?: (url: string) => void | Promise<void>;
  /** Field name, used to show the server's error for this field (`fieldErrors[name]`). */
  name?: string;
  help?: React.ReactNode;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  /** Preview shape: `wide` for hero/cover/section images, `square` for logos, icons and dishes. */
  shape?: "wide" | "square";
  className?: string;
};

type ServerError = { code?: string; message?: string; fieldErrors?: Record<string, string[]> };

export function ImageUploader({ label, purpose, value, onChange, onCommit, name, help, error, required, disabled = false, shape = "wide", className }: ImageUploaderProps) {
  const [problem, setProblem] = React.useState<string | null>(null);
  const wiring = useFieldWiring({ name, label, required, help, error: problem ?? error });
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [state, setState] = React.useState<UploadState>(value ? "UPLOADED" : "IDLE");
  const [progress, setProgress] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const [linkMode, setLinkMode] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const lastFile = React.useRef<File | null>(null);
  /** Asset uploaded in this editing session and not known to be saved: safe to discard if replaced or removed. */
  const [pending, setPending] = React.useState<{ id: string; url: string } | null>(null);
  const request = React.useRef<XMLHttpRequest | null>(null);

  React.useEffect(() => () => request.current?.abort(), []);
  // A value changed from outside (form reset, saved data applied) settles the idle/uploaded state.
  React.useEffect(() => {
    setState((current) => (current === "UPLOADING" || current === "PROCESSING" || current === "VALIDATING" || current === "REMOVING" ? current : value ? "UPLOADED" : "IDLE"));
  }, [value]);

  const busy = state === "SELECTED" || state === "VALIDATING" || state === "UPLOADING" || state === "PROCESSING" || state === "REMOVING";
  const shownError = wiring.message;

  function announce(text: string) {
    setAnnouncement(text);
  }

  function fail(message: string) {
    setProblem(message);
    setState("FAILED");
    announce(`Upload failed. ${message}`);
  }

  async function discard(previous: { id: string } | null) {
    if (!previous) return;
    try {
      await fetch(`/api/v1/media/${encodeURIComponent(previous.id)}`, { method: "DELETE", credentials: "same-origin" });
    } catch {
      // Not critical: an unused upload is also cleaned up by the server's abandoned-upload sweep.
    }
  }

  function start(file: File) {
    lastFile.current = file;
    setProblem(null);
    setState("SELECTED");
    announce(`${file.name} selected.`);

    setState("VALIDATING");
    if (!ACCEPT.includes(file.type)) return fail("Only JPG, PNG and WebP images can be uploaded.");
    if (file.size > MAX_BYTES) return fail("The image is larger than 5 MB. Choose a smaller file.");
    if (file.size === 0) return fail("That file is empty.");

    const body = new FormData();
    body.append("purpose", purpose);
    body.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    request.current = xhr;
    xhr.open("POST", "/api/v1/media/uploads");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      setProgress(percent);
      if (percent >= 100) setState("PROCESSING");
    };
    xhr.upload.onload = () => {
      setState("PROCESSING");
      announce("Upload sent. Optimising the image…");
    };
    xhr.onerror = () => fail("The connection dropped. Check your internet and try again.");
    xhr.onabort = () => setState(value ? "UPLOADED" : "IDLE");
    xhr.onload = () => {
      request.current = null;
      const payload = (xhr.response ?? {}) as { asset?: { id: string; url: string }; error?: ServerError };
      if (xhr.status === 201 && payload.asset?.url) {
        void discard(pending);
        setPending({ id: payload.asset.id, url: payload.asset.url });
        onChange(payload.asset.url);
        setState("UPLOADED");
        announce(onCommit ? "Image uploaded." : "Image uploaded. Save to publish it.");
        void onCommit?.(payload.asset.url);
        return;
      }
      const serverError = payload.error;
      if (serverError?.code === "UPLOADS_DISABLED") setLinkMode(true);
      fail(serverError?.fieldErrors?.file?.[0] ?? serverError?.message ?? "The image could not be uploaded. Try again.");
    };
    setProgress(0);
    setState("UPLOADING");
    announce("Uploading…");
    xhr.send(body);
  }

  function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) start(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function remove() {
    setState("REMOVING");
    announce("Removing image…");
    await discard(pending);
    setPending(null);
    onChange("");
    setProblem(null);
    setState("IDLE");
    announce(onCommit ? "Image removed." : "Image removed. Save to apply.");
    await onCommit?.("");
  }

  const previewSrc = value ? imageKitSized(value, shape === "wide" ? 960 : 480) : null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span id={`${wiring.controlId}-label`} className="text-label text-fg-primary">
        {label}
        {required && <RequiredMark />}
      </span>

      <input
        ref={inputRef}
        id={wiring.controlId}
        type="file"
        accept={ACCEPT.join(",")}
        className="sr-only"
        tabIndex={-1}
        disabled={disabled || busy}
        aria-labelledby={`${wiring.controlId}-label`}
        onChange={(event) => onFiles(event.target.files)}
      />

      {value && !busy ? (
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-raised">
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageKit resizes; next/image would re-process it. */}
          <img src={previewSrc ?? undefined} alt={`${label} preview`} className={cn("w-full object-cover", shape === "wide" ? "aspect-[16/9]" : "mx-auto aspect-square max-w-60")} />
          <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <span className="flex items-center gap-1.5 text-caption text-status-success">
              <Icon icon={CircleCheck} size={16} />
              {pending?.url === value && !onCommit ? "Uploaded — save to publish" : "Current image"}
            </span>
            {!disabled && (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => inputRef.current?.click()}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove()}>
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          aria-describedby={wiring.describedBy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled && !busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!disabled && !busy) onFiles(event.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors",
            shape === "wide" ? "min-h-40" : "min-h-32",
            dragging ? "border-action-primary bg-raised" : "border-border-strong hover:bg-raised",
            (disabled || busy) && "cursor-not-allowed opacity-70",
            shownError && "border-status-danger",
          )}
        >
          {busy ? (
            <>
              <span className="text-label text-fg-primary">{state === "PROCESSING" ? "Optimising…" : state === "REMOVING" ? "Removing…" : `Uploading… ${progress}%`}</span>
              <span className="h-1.5 w-full max-w-60 overflow-hidden rounded-full bg-border-subtle" aria-hidden="true">
                <span className="block h-full bg-action-primary transition-[width]" style={{ width: `${state === "PROCESSING" || state === "REMOVING" ? 100 : progress}%` }} />
              </span>
            </>
          ) : (
            <>
              <Icon icon={ImagePlus} size={24} className="text-fg-secondary" />
              <span className="text-label text-fg-primary">{dragging ? "Drop to upload" : "Upload image"}</span>
              <span className="text-caption text-fg-secondary">JPG, PNG or WebP · up to 5 MB · click or drag a file here</span>
            </>
          )}
        </button>
      )}

      {state === "FAILED" && lastFile.current && !disabled && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => lastFile.current && start(lastFile.current)}>
            Retry
          </Button>
        </div>
      )}

      {!disabled && (
        <button type="button" className="flex w-fit items-center gap-1.5 text-caption text-fg-secondary underline-offset-2 hover:text-fg-primary hover:underline" onClick={() => setLinkMode((open) => !open)} aria-expanded={linkMode}>
          <Icon icon={Link2} size={16} />
          {linkMode ? "Hide image link" : "Use an image link instead"}
        </button>
      )}
      {linkMode && (
        <TextInput
          type="url"
          inputMode="url"
          maxLength={2048}
          autoComplete="off"
          placeholder="https://"
          aria-label={`${label} link`}
          disabled={disabled || busy}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {help && wiring.helpId && <FieldHelp id={wiring.helpId}>{help}</FieldHelp>}
      {shownError && (
<FieldError id={wiring.errorId}>{shownError}</FieldError>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
