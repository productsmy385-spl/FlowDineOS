import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/landing/legal-page";
import { COMPANY_NAME, PLATFORM_DOMAIN, PLATFORM_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Terms — ${PLATFORM_NAME}`,
  description: `Terms for using ${PLATFORM_NAME}, restaurant software by ${COMPANY_NAME}.`,
  alternates: { canonical: `https://${PLATFORM_DOMAIN}/terms` },
};

/**
 * Terms of use (owner request 2026-10-07). Written to match how FlowDineOS is actually provided — licensed software, no
 * subscription plans (ADR-002) — and to be reviewed by the owner's legal adviser before it is relied on.
 */
export default function TermsPage() {
  return (
    <LegalPage title="Terms of Use" updated="7 October 2026">
      <p>
        These terms apply to {PLATFORM_NAME}, restaurant software provided by {COMPANY_NAME}, including the restaurant console, restaurants&apos; public
        websites and table menus, and the local print agent. Using {PLATFORM_NAME} means accepting these terms. A restaurant&apos;s own written agreement
        with {COMPANY_NAME}, where there is one, takes precedence.
      </p>

      <h2>The software</h2>
      <p>
        {PLATFORM_NAME} is licensed to restaurants as software. Which features a restaurant can use is agreed with {COMPANY_NAME} and set up for that
        restaurant. There are no subscription plans on this website.
      </p>

      <h2>Accounts and access</h2>
      <ul>
        <li>Owners, administrators and managers are invited by email; staff receive a daily password from their administrator.</li>
        <li>Keep sign-in codes and daily passwords private. Each restaurant is responsible for whom it invites and the roles it gives them.</li>
        <li>Tell us promptly if you believe an account has been misused.</li>
      </ul>

      <h2>The restaurant&apos;s responsibilities</h2>
      <ul>
        <li>Its menus, prices, taxes, bills and website content are its own, and it is responsible for them being accurate and lawful.</li>
        <li>It decides which customer details to record and must have a lawful basis to do so.</li>
        <li>It is responsible for keeping the records the law requires it to keep, such as tax and GST records. {PLATFORM_NAME} lets it download them at any time; deleting old history is its own decision and requires a backup first.</li>
        <li>It provides and maintains its own computers, network and thermal printers. A ticket is shown as delivered when the print agent reports that the printer accepted it.</li>
      </ul>

      <h2>Acceptable use</h2>
      <ul>
        <li>Do not try to reach another restaurant&apos;s data, get around access controls or rate limits, or disrupt the service.</li>
        <li>Do not upload unlawful content or content you do not have the right to use.</li>
      </ul>

      <h2>Data</h2>
      <p>
        A restaurant&apos;s data belongs to the restaurant. How personal information is handled is described in the <Link href="/privacy" className="text-fg-accent">Privacy Policy</Link>.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We work to keep {PLATFORM_NAME} available and secure, but cannot promise it will be uninterrupted or error-free. We may improve or change features;
        we will not remove a restaurant&apos;s access to its own data without notice.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, {COMPANY_NAME} is not liable for indirect or consequential losses, such as lost profits, arising from use of{" "}
        {PLATFORM_NAME}. Nothing in these terms limits liability that cannot be limited by law.
      </p>

      <h2>Law</h2>
      <p>These terms are governed by the laws of India.</p>

      <h2>Changes to these terms</h2>
      <p>If these terms change, the new version will be published on this page with its date.</p>
    </LegalPage>
  );
}
