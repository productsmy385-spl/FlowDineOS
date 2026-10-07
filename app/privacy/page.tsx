import type { Metadata } from "next";
import { LegalPage } from "@/components/landing/legal-page";
import { COMPANY_NAME, PLATFORM_DOMAIN, PLATFORM_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Privacy Policy — ${PLATFORM_NAME}`,
  description: `How ${COMPANY_NAME} handles personal information in ${PLATFORM_NAME}.`,
  alternates: { canonical: `https://${PLATFORM_DOMAIN}/privacy` },
};

/**
 * Privacy Policy (owner request 2026-10-07). Describes what the software actually does — the data it stores, the
 * services it relies on, the controls restaurants have — and nothing it does not. To be reviewed by the owner's legal
 * adviser before it is relied on.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="7 October 2026">
      <p>
        {PLATFORM_NAME} is restaurant software provided by {COMPANY_NAME}. This policy explains what personal information {PLATFORM_NAME} handles, why, and the
        choices available. It covers the {PLATFORM_NAME} website at {PLATFORM_DOMAIN}, the restaurant console, restaurants&apos; public websites and table menus
        served by {PLATFORM_NAME}, and the local print agent.
      </p>

      <h2>Who is responsible</h2>
      <p>
        For information a restaurant enters about its own customers, staff, orders and payments, the restaurant decides what is collected and why, and{" "}
        {PLATFORM_NAME} processes it on the restaurant&apos;s behalf. For information about people who contact us or request a demo, and about the
        restaurant accounts themselves, {COMPANY_NAME} is responsible.
      </p>

      <h2>What we handle</h2>
      <ul>
        <li>Restaurant owners, administrators and managers: name, work email and sign-in records. Sign-in uses one-time codes sent by email.</li>
        <li>Restaurant staff: name, work email, role, and attendance (when they signed in and out). Staff daily passwords are stored only as secure hashes and expire every day; they are never stored or shown in readable form after they are issued.</li>
        <li>Restaurant customers, when a restaurant records them: name, phone number, email and notes, linked to their orders.</li>
        <li>Orders, bills, payments, refunds and day closes, with the prices and tax charged.</li>
        <li>Restaurant settings, menus, website content and images the restaurant uploads.</li>
        <li>Demo requests from this website: name, business name, mobile number, email, city, preferred date and time, number of outlets and any message.</li>
        <li>Security records: an audit log of important changes (who did what and when) and the network address of requests, kept to protect accounts and detect misuse.</li>
      </ul>

      <h2>What we do not do</h2>
      <ul>
        <li>We do not sell personal information or use it for advertising.</li>
        <li>Guests browsing a restaurant&apos;s website or table menu do not need an account, and {PLATFORM_NAME} does not add advertising or third-party tracking scripts to those pages.</li>
        <li>Sharing a restaurant or a dish only opens the guest&apos;s own app (WhatsApp, Facebook) or copies text; nothing is posted on anyone&apos;s behalf.</li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To run the service: taking orders, sending tickets to the kitchen and printers, recording payments and producing reports.</li>
        <li>To keep accounts secure: signing people in, limiting access by role, rate-limiting sign-in attempts and keeping an audit log.</li>
        <li>To respond to demo requests and messages.</li>
      </ul>

      <h2>Services we rely on</h2>
      <p>
        {PLATFORM_NAME} runs on a cloud hosting provider with a PostgreSQL database. Sign-in for owners, administrators and managers is provided by Clerk.
        Images restaurants upload are stored and delivered by ImageKit. These providers process information only to provide their service to us.
      </p>

      <h2>Separation between restaurants</h2>
      <p>
        Each restaurant&apos;s data is kept separate. Which restaurant a person belongs to, and what their role may do, is decided on our servers for every
        request — never by anything a browser sends.
      </p>

      <h2>How long information is kept</h2>
      <p>
        Restaurant data is kept while the restaurant uses {PLATFORM_NAME}. A restaurant&apos;s owner can download its records at any time and can delete
        history older than a chosen date after downloading a backup. The record of each backup, restore and deletion is kept permanently. Demo requests are
        kept while we follow them up.
      </p>

      <h2>Your choices</h2>
      <p>
        If a restaurant holds your details as its customer, contact that restaurant to see, correct or remove them. To ask about information{" "}
        {COMPANY_NAME} holds about you, or a demo request you made, contact us using the details below.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, the new version will be published on this page with its date.</p>
    </LegalPage>
  );
}
