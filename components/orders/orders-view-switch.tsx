import Link from "next/link";
import { LayoutList, ShoppingBag } from "lucide-react";

export type OrdersView = "takeaway" | "all";

/**
 * The Orders page's segmented switch (owner brief 2026-10-14): Takeaway first, every order (delivery and dine-in
 * included) under "All orders". Dine-in tables are their own navigation item. Plain links with `aria-current`, so a view
 * is bookmarkable and switching never touches an order. Large tap targets on a phone; never wider than the page.
 */
const SEGMENTS: ReadonlyArray<{ view: OrdersView; label: string; icon: typeof ShoppingBag }> = [
  { view: "takeaway", label: "Takeaway", icon: ShoppingBag },
  { view: "all", label: "All orders", icon: LayoutList },
];

export function OrdersViewSwitch({ active }: { active: OrdersView }) {
  return (
    <nav aria-label="Order views" className="w-full sm:w-auto">
      <ul className="grid grid-cols-2 gap-1 rounded-2xl border border-border-subtle bg-card p-1 sm:inline-grid sm:w-auto">
        {SEGMENTS.map((segment) => {
          const current = segment.view === active;
          const Icon = segment.icon;
          return (
            <li key={segment.view}>
              <Link
                href={`/restaurant/orders?view=${segment.view}`}
                aria-current={current ? "page" : undefined}
                className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-label transition-colors duration-fast ease-standard sm:px-5 ${
                  current ? "bg-action-primary text-action-primary-fg shadow-e1" : "text-fg-primary hover:bg-raised"
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{segment.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
