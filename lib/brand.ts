/**
 * Platform branding (owner brief 2026-10-06: RasoiOS → FlowDineOS). The platform's name and its company are one layer;
 * each restaurant's own name, logo and colours are another and are never replaced by these.
 *
 * Internal identifiers that live outside this codebase keep their old spelling on purpose — the print agent's install
 * folder and scheduled task on restaurant PCs, cookie names, the backup file format tag — so that agents already
 * installed and backups already downloaded keep working.
 */
export const PLATFORM_NAME = "FlowDineOS";
export const PLATFORM_TAGLINE = "Restaurant operations, simplified.";
export const PLATFORM_DOMAIN = "flowdine.in";
export const COMPANY_NAME = "KJS TECH INNOVATIONS";
export const COMPANY_ADDRESS = ["4-177/1, Duddukuru", "Devarapalli Mandal", "East Godavari District", "Andhra Pradesh 534313", "India"] as const;
export const COMPANY_EMAILS = ["gopalakrishnaeerothu@gmail.com", "jayendrasimhadri@gmail.com", "productsmy385@gmail.com"] as const;
export const COPYRIGHT = `© 2026 ${COMPANY_NAME}`;
