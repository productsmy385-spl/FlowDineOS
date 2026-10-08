/**
 * Icon maps (S1-P08-T003, design.md §5.1 and §7). The single place domain concepts and statuses get their Lucide icon;
 * every name is checked by the TypeScript compiler against lucide-react.
 */
import {
  AtSign,
  Apple,
  Archive,
  BadgeCheck,
  Ban,
  Beef,
  Beer,
  Bell,
  BellRing,
  Bike,
  BookOpen,
  CakeSlice,
  CalendarDays,
  Carrot,
  ChartColumn,
  ChefHat,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleDotDashed,
  CircleX,
  Citrus,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Coffee,
  Cookie,
  CookingPot,
  Croissant,
  CupSoda,
  Drumstick,
  EggFried,
  EyeOff,
  FilePen,
  Fish,
  Flame,
  GlassWater,
  Globe,
  GripVertical,
  HandPlatter,
  IceCreamCone,
  ImageOff,
  LayoutDashboard,
  LayoutList,
  Leaf,
  LoaderCircle,
  RefreshCw,
  Mail,
  MapPin,
  Phone,
  Pizza,
  Popcorn,
  Printer,
  PrinterCheck,
  Receipt,
  Salad,
  Sandwich,
  ScrollText,
  Send,
  Settings,
  Share2,
  ShoppingBag,
  Soup,
  SquarePlus,
  Store,
  Ticket,
  Timer,
  TriangleAlert,
  Undo2,
  UserCog,
  UserX,
  Users,
  UtensilsCrossed,
  Wheat,
  Wifi,
  WifiOff,
  Wine,
  type LucideIcon,
} from "lucide-react";

export const DOMAIN_ICONS = {
  dashboard: LayoutDashboard,
  restaurant: Store,
  menu: BookOpen,
  dineIn: UtensilsCrossed,
  categories: LayoutList,
  dailyMenu: CalendarDays,
  orders: ClipboardList,
  newOrder: SquarePlus,
  takeaway: ShoppingBag,
  delivery: Bike,
  priorityHigh: Flame,
  timer: Timer,
  preparing: CookingPot,
  agentOnline: Wifi,
  agentOffline: WifiOff,
  dragHandle: GripVertical,
  kitchen: ChefHat,
  kot: Ticket,
  printer: Printer,
  printerOk: PrinterCheck,
  transactions: Receipt,
  customers: Users,
  reports: ChartColumn,
  social: Share2,
  website: Globe,
  staff: UserCog,
  settings: Settings,
  audit: ScrollText,
  clock: Clock,
  notification: Bell,
  ready: BellRing,
  location: MapPin,
  phone: Phone,
  email: AtSign,
  imageFallback: ImageOff,
} satisfies Record<string, LucideIcon>;

/** Curated fallback icons for menu categories and items (design.md §5.1). Stored in `icon_key` columns. */
export const MENU_ICONS = {
  Soup,
  Salad,
  Sandwich,
  Pizza,
  Beef,
  Drumstick,
  Fish,
  EggFried,
  Croissant,
  CakeSlice,
  IceCreamCone,
  Coffee,
  CupSoda,
  Wine,
  Beer,
  GlassWater,
  Cookie,
  Popcorn,
  Wheat,
  Carrot,
  Apple,
  Citrus,
  Flame,
  Leaf,
  UtensilsCrossed,
  CookingPot,
} satisfies Record<string, LucideIcon>;

export type MenuIconKey = keyof typeof MENU_ICONS;
export const MENU_ICON_KEYS = Object.keys(MENU_ICONS) as MenuIconKey[];

export function isMenuIconKey(value: unknown): value is MenuIconKey {
  return typeof value === "string" && value in MENU_ICONS;
}

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

/**
 * Domain hues (design.md §5.2, ADR-013 §5). A domain hue colours an icon and its tile wash only — never body text,
 * table rows or large fills — and colour always arrives with a label. The `-soft` steps are the lighter 200/300 steps
 * of their scale, which is how design.md §5.2 separates Kitchen from Orders and Website from Reports.
 *
 * These names sit alongside `Tone`, which is the *status* vocabulary (design.md §7). Statuses stay theme-aware;
 * domain hues are console-only (the console is always dark), so they may name scale steps directly.
 */
export type DomainHue = Tone | "secondary" | "secondary-soft" | "tertiary-soft" | "accent" | "accent-soft";

export const DOMAIN_HUES = {
  dashboard: "primary",
  orders: "secondary",
  kitchen: "secondary-soft",
  menu: "warning",
  transactions: "warning",
  customers: "tertiary-soft",
  reports: "accent",
  printing: "accent",
  website: "accent-soft",
  social: "accent-soft",
  settings: "neutral",
  audit: "neutral",
  restaurant: "primary",
  staff: "tertiary-soft",
} as const satisfies Record<string, DomainHue>;

export type DomainHueKey = keyof typeof DOMAIN_HUES;

export type StatusVisual = { icon: LucideIcon; tone: Tone; label: string; muted?: boolean; strike?: boolean };

/** design.md §7 — every status is shown with icon + label + tone, never colour alone. */
export const STATUS_ICONS = {
  order: {
    NEW: { icon: CircleDot, tone: "primary", label: "New" },
    ACCEPTED: { icon: ClipboardCheck, tone: "neutral", label: "Accepted" },
    PREPARING: { icon: CookingPot, tone: "warning", label: "Preparing" },
    READY: { icon: BellRing, tone: "success", label: "Ready" },
    COMPLETED: { icon: CircleCheckBig, tone: "success", label: "Completed", muted: true },
    CANCELLED: { icon: CircleX, tone: "danger", label: "Cancelled" },
    REFUNDED: { icon: Undo2, tone: "neutral", label: "Refunded" },
  },
  payment: {
    UNPAID: { icon: CircleDashed, tone: "neutral", label: "Unpaid" },
    PARTIALLY_PAID: { icon: CircleDotDashed, tone: "warning", label: "Part paid" },
    PAID: { icon: BadgeCheck, tone: "success", label: "Paid" },
    PARTIALLY_REFUNDED: { icon: Undo2, tone: "warning", label: "Part refunded" },
    REFUNDED: { icon: Undo2, tone: "neutral", label: "Refunded" },
  },
  kot: {
    QUEUED: { icon: Clock, tone: "neutral", label: "Queued" },
    PREPARING: { icon: CookingPot, tone: "warning", label: "Preparing" },
    READY: { icon: BellRing, tone: "success", label: "Ready" },
    SERVED: { icon: HandPlatter, tone: "neutral", label: "Served" },
    CANCELLED: { icon: CircleX, tone: "danger", label: "Cancelled" },
  },
  printJob: {
    // Labels say exactly what is known (owner review 2026-10-06): PRINTED means the print agent delivered every byte to
    // the printer and the printer accepted them — not merely that the agent took the job.
    PENDING: { icon: Clock, tone: "neutral", label: "Queued" },
    PROCESSING: { icon: LoaderCircle, tone: "primary", label: "Sending to printer" },
    PRINTED: { icon: PrinterCheck, tone: "success", label: "Delivered to printer" },
    FAILED: { icon: TriangleAlert, tone: "danger", label: "Failed" },
    CANCELLED: { icon: CircleX, tone: "neutral", label: "Cancelled", muted: true },
  },
  // What staff see for a print job (lib/print/state-machine.ts displayStatus, 2026-10-08): a queued job that already
  // failed once is "Retrying", and nothing claims paper came out.
  printJobDisplay: {
    QUEUED: { icon: Clock, tone: "neutral", label: "Queued" },
    PRINTING: { icon: LoaderCircle, tone: "primary", label: "Sending to printer" },
    RETRYING: { icon: RefreshCw, tone: "warning", label: "Retrying" },
    DELIVERED: { icon: PrinterCheck, tone: "success", label: "Delivered to printer" },
    FAILED: { icon: TriangleAlert, tone: "danger", label: "Failed" },
    CANCELLED: { icon: CircleX, tone: "neutral", label: "Cancelled", muted: true },
  },
  dailyMenu: {
    DRAFT: { icon: FilePen, tone: "neutral", label: "Draft" },
    PUBLISHED: { icon: Globe, tone: "success", label: "Published" },
    UNPUBLISHED: { icon: EyeOff, tone: "neutral", label: "Unpublished" },
  },
  tenant: {
    ACTIVE: { icon: CircleCheck, tone: "success", label: "Active" },
    SUSPENDED: { icon: Ban, tone: "danger", label: "Suspended" },
  },
  membership: {
    INVITED: { icon: Mail, tone: "warning", label: "Invited" },
    ACTIVE: { icon: CircleCheck, tone: "success", label: "Active" },
    INACTIVE: { icon: UserX, tone: "neutral", label: "Inactive" },
  },
  agent: {
    ONLINE: { icon: Wifi, tone: "success", label: "Online" },
    OFFLINE: { icon: WifiOff, tone: "danger", label: "Offline" },
    REVOKED: { icon: Ban, tone: "neutral", label: "Revoked" },
  },
  social: {
    DRAFT: { icon: FilePen, tone: "neutral", label: "Draft" },
    READY: { icon: CircleCheck, tone: "primary", label: "Ready" },
    MARKED_POSTED: { icon: Send, tone: "success", label: "Marked posted" },
    ARCHIVED: { icon: Archive, tone: "neutral", label: "Archived" },
  },
  transaction: {
    SUCCESS: { icon: BadgeCheck, tone: "success", label: "Recorded" },
    VOIDED: { icon: Ban, tone: "neutral", label: "Voided", strike: true },
  },
} as const satisfies Record<string, Record<string, StatusVisual>>;

export type StatusDomain = keyof typeof STATUS_ICONS;
