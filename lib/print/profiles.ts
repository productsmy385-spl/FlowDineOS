/**
 * Printer capability profiles (printing audit 2026-10-08, P1). Dependency-free: the console validates against these
 * keys and the local print agent (bundled from this file) encodes ESC/POS by the profile's capabilities, so no printer is
 * assumed to behave like every other.
 *
 * `source` says where a capability comes from. Nothing here is marked hardware-verified until the printer has passed
 * knowledge/implementation/printing-hardware-checklist.md with real paper.
 *
 * Extensibility (owner decision 2026-10-08): `supportsBitmap` gates raster printing. Multilingual text (Telugu and
 * other Indic scripts) will be added later as a raster text renderer behind the agent's `TextRenderer` seam
 * (print-agent/src/escpos.ts) — the queue, the payload contract and the transports do not change for it.
 */
export type CutMode = "partial" | "full" | "none";

export type PrinterProfile = {
  key: string;
  label: string;
  protocol: "ESC_POS";
  /** Paper widths this model takes. */
  paperWidthsMm: ReadonlyArray<58 | 80>;
  /** Printable columns at font A for each width. */
  columns: Readonly<Partial<Record<58 | 80, number>>>;
  /** Text bytes the agent sends: printable ASCII after transliteration (no code-page dependent characters). */
  encoding: "ascii";
  /** `ESC t n` code page selected at the start of every ticket. */
  codePage: number;
  cut: CutMode;
  supportsQr: boolean;
  supportsBarcode: boolean;
  supportsBitmap: boolean;
  /** Real-time status (`DLE EOT`) answered over the connection — needed before "delivered" can mean "on paper". */
  supportsStatus: boolean;
  supportsBuzzer: boolean;
  source: "conservative default" | "manufacturer specification";
  hardwareVerified: boolean;
};

export const PRINTER_PROFILES = {
  GENERIC_ESCPOS: {
    key: "GENERIC_ESCPOS",
    label: "Generic ESC/POS thermal printer",
    protocol: "ESC_POS",
    paperWidthsMm: [58, 80],
    columns: { 58: 32, 80: 48 },
    encoding: "ascii",
    codePage: 0,
    cut: "partial",
    supportsQr: false,
    supportsBarcode: false,
    supportsBitmap: false,
    supportsStatus: false,
    supportsBuzzer: false,
    source: "conservative default",
    hardwareVerified: false,
  },
  TVS_RP3230: {
    key: "TVS_RP3230",
    label: "TVS-E RP 3230",
    protocol: "ESC_POS",
    paperWidthsMm: [80],
    columns: { 80: 48 },
    encoding: "ascii",
    codePage: 0,
    cut: "partial",
    supportsQr: true,
    supportsBarcode: true,
    supportsBitmap: true,
    // Real-time status over Ethernet is not documented for this model; not used until verified on hardware.
    supportsStatus: false,
    supportsBuzzer: false,
    source: "manufacturer specification",
    hardwareVerified: false,
  },
} as const satisfies Record<string, PrinterProfile>;

export type PrinterProfileKey = keyof typeof PRINTER_PROFILES;
export const PRINTER_PROFILE_KEYS = Object.keys(PRINTER_PROFILES) as PrinterProfileKey[];
export const DEFAULT_PRINTER_PROFILE: PrinterProfileKey = "GENERIC_ESCPOS";

export function isPrinterProfileKey(value: unknown): value is PrinterProfileKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRINTER_PROFILES, value);
}

/** The profile for a stored key; an unknown key (a newer server, an edited row) falls back to the conservative default. */
export function profileOf(key: string | null | undefined): PrinterProfile {
  return isPrinterProfileKey(key) ? PRINTER_PROFILES[key] : PRINTER_PROFILES[DEFAULT_PRINTER_PROFILE];
}
