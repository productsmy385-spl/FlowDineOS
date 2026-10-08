/**
 * Printing error catalogue (printing audit 2026-10-08, D1). Dependency-free: the server, the console and the local
 * print agent (bundled from this file) use the same codes.
 *
 * Every code has a stable machine name, a technical line for administrators, a plain sentence for staff that names the
 * printer, and whether retrying can help. A connection that never opened (unreachable, refused, timed out) is never
 * explained as a paper problem: only the printer itself could tell us that, and over raw TCP it does not.
 *
 * Agents released before this catalogue send the older codes (`PRINTER_OFFLINE`, `TIMEOUT`, …); {@link canonicalPrintErrorCode}
 * maps them, using the agent's own message to tell a connect timeout from a send timeout.
 */
export type PrintErrorCode =
  | "AGENT_OFFLINE"
  | "AGENT_NOT_RESPONDING"
  | "PRINTER_NOT_FOUND"
  | "PRINTER_NOT_ASSIGNED"
  | "PRINTER_DISABLED"
  | "PRINTER_UNREACHABLE"
  | "PRINTER_PORT_UNREACHABLE"
  | "CONNECTION_TIMEOUT"
  | "CONNECTION_REFUSED"
  | "CONNECTION_RESET"
  | "PRINT_SEND_FAILED"
  | "DELIVERY_UNKNOWN"
  | "ESC_POS_RENDER_FAILED"
  | "UNSUPPORTED_PRINTER"
  | "INVALID_PRINTER_CONFIGURATION"
  | "PRINT_JOB_CANCELLED"
  | "PRINT_JOB_EXPIRED"
  | "LEASE_EXPIRED"
  | "PRINT_FAILED";

type Entry = { technical: string; user: (printer: string) => string; retryable: boolean; offline: boolean };

export const PRINT_ERRORS: Readonly<Record<PrintErrorCode, Entry>> = {
  AGENT_OFFLINE: {
    technical: "The print agent has not checked in within the heartbeat window.",
    user: (p) => `The print agent for ${p} is offline. Check that the computer running it is on and connected to the internet.`,
    retryable: true,
    offline: true,
  },
  AGENT_NOT_RESPONDING: {
    technical: "The print agent did not pick up the request in time (offline, or a version without this feature).",
    user: (p) => `The print agent for ${p} did not answer. Check it is running, and update it if it is an older version.`,
    retryable: true,
    offline: true,
  },
  PRINTER_NOT_FOUND: {
    technical: "The printer is not assigned to the agent that received the job.",
    user: (p) => `${p} is not set up on this print agent. Check the printer's agent in Printing → Printers.`,
    retryable: false,
    offline: false,
  },
  PRINTER_NOT_ASSIGNED: {
    technical: "The printer has no print agent assigned.",
    user: (p) => `${p} has no print agent. Edit the printer and choose the agent on the computer it is connected to.`,
    retryable: false,
    offline: false,
  },
  PRINTER_DISABLED: {
    technical: "The printer was deactivated.",
    user: (p) => `${p} is deactivated.`,
    retryable: false,
    offline: false,
  },
  PRINTER_UNREACHABLE: {
    technical: "No route to the printer's address (host or network unreachable).",
    user: (p) => `${p} is unreachable. Check its network cable or Wi-Fi, and that it is on the same network as the print agent's computer.`,
    retryable: true,
    offline: true,
  },
  PRINTER_PORT_UNREACHABLE: {
    technical: "The printer's address answered, but not on the configured port.",
    user: (p) => `${p} answers on the network but not on its printing port. Check the port (usually 9100).`,
    retryable: true,
    offline: true,
  },
  CONNECTION_TIMEOUT: {
    technical: "No answer to a TCP connection to the printer's address and port.",
    user: (p) =>
      `${p} is unreachable — it did not answer. Check it is switched on and connected, and that its IP address has not changed (reserve it in the router).`,
    retryable: true,
    offline: true,
  },
  CONNECTION_REFUSED: {
    technical: "The printer's address refused the TCP connection on this port.",
    user: (p) => `${p} refused the connection. Check the port (usually 9100) and that nothing else is using the printer.`,
    retryable: true,
    offline: true,
  },
  CONNECTION_RESET: {
    technical: "The printer closed the connection before any data was sent.",
    user: (p) => `${p} dropped the connection. It may be restarting; printing will be retried.`,
    retryable: true,
    offline: false,
  },
  PRINT_SEND_FAILED: {
    technical: "The connection opened, but the ticket could not be sent.",
    user: (p) => `${p} could not take the ticket. Printing will be retried.`,
    retryable: true,
    offline: false,
  },
  DELIVERY_UNKNOWN: {
    technical: "The printer stopped accepting data part-way through the ticket; it may have printed some or all of it.",
    user: (p) => `${p} stopped part-way through this ticket. Check paper and cover, and choose Retry only if nothing came out.`,
    retryable: false,
    offline: false,
  },
  ESC_POS_RENDER_FAILED: {
    technical: "The agent could not turn this ticket into printer commands.",
    user: () => "This ticket could not be prepared for printing. Update the print agent, then retry.",
    retryable: false,
    offline: false,
  },
  UNSUPPORTED_PRINTER: {
    technical: "This connection type is not supported on the print agent's operating system.",
    user: (p) => `${p} uses a connection this print agent's computer does not support.`,
    retryable: false,
    offline: false,
  },
  INVALID_PRINTER_CONFIGURATION: {
    technical: "The printer's address is not valid for its connection type.",
    user: (p) => `${p} has an invalid address. LAN printers need a private IPv4 address such as 192.168.1.50:9100.`,
    retryable: false,
    offline: false,
  },
  PRINT_JOB_CANCELLED: {
    technical: "The job was cancelled.",
    user: () => "This ticket was cancelled.",
    retryable: false,
    offline: false,
  },
  PRINT_JOB_EXPIRED: {
    technical: "Automatic retries stopped at the end of the job type's retry window.",
    user: (p) => `${p} stayed unavailable, so automatic retries stopped. Fix the printer, then choose Retry.`,
    retryable: false,
    offline: false,
  },
  LEASE_EXPIRED: {
    technical: "The agent claimed the job but did not report back before its lease expired.",
    user: (p) => `The print agent for ${p} stopped answering mid-job. It will be tried again.`,
    retryable: true,
    offline: false,
  },
  PRINT_FAILED: {
    technical: "Printing failed for an unspecified reason.",
    user: (p) => `${p} could not print this ticket.`,
    retryable: true,
    offline: false,
  },
};

export function isPrintErrorCode(code: string | null | undefined): code is PrintErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PRINT_ERRORS, code);
}

/**
 * The catalogue code for whatever an agent reported. Codes from agents released before 2026-10-08 are translated; the
 * old `TIMEOUT` meant either "never connected" or "stopped taking data", which only its message distinguishes.
 */
export function canonicalPrintErrorCode(code: string | null | undefined, message?: string | null): PrintErrorCode {
  if (isPrintErrorCode(code)) return code;
  switch (code) {
    case "PRINTER_OFFLINE":
      return "PRINTER_UNREACHABLE";
    case "TIMEOUT":
      return /stopped accepting data/i.test(message ?? "") ? "DELIVERY_UNKNOWN" : "CONNECTION_TIMEOUT";
    case "WRITE_FAILED":
      return "PRINT_SEND_FAILED";
    case "INVALID_ADDRESS":
      return "INVALID_PRINTER_CONFIGURATION";
    case "UNSUPPORTED_PLATFORM":
      return "UNSUPPORTED_PRINTER";
    case "INVALID_PAYLOAD":
      return "ESC_POS_RENDER_FAILED";
    case "UNKNOWN_PRINTER":
      return "PRINTER_NOT_FOUND";
    case "PRINTER_DEACTIVATED":
      return "PRINTER_DISABLED";
    default:
      return "PRINT_FAILED";
  }
}

export type DescribedPrintError = { code: PrintErrorCode; technical: string; user: string; retryable: boolean; offline: boolean };

/** Everything the console shows for one error: the plain sentence for staff and the technical line for admins. */
export function describePrintError(code: string | null | undefined, printerName: string, message?: string | null): DescribedPrintError {
  const canonical = canonicalPrintErrorCode(code, message);
  const entry = PRINT_ERRORS[canonical];
  return { code: canonical, technical: entry.technical, user: entry.user(printerName), retryable: entry.retryable, offline: entry.offline };
}
