import { parseLanAddress } from "@/lib/print/address";
import { isVirtualAddress } from "@/lib/print/virtual-printer";
import type { AgentPrinter } from "../api";
import { LanTransport } from "./lan";
import { PrintTransportError, type Transport } from "./types";
import { UsbTransport } from "./usb";
import { VirtualTransport } from "./virtual";

export { PrintTransportError, type Transport } from "./types";
export { VirtualTransport } from "./virtual";

/**
 * The transport for one of the agent's printers. The address is re-validated here even though the console already
 * validated it (SC-PRINT-06): the agent must not become a way to reach a public or loopback address just because a row
 * in the server's database says so.
 */
export function transportFor(printer: Pick<AgentPrinter, "connectionType" | "connectionAddress">): Transport {
  if (isVirtualAddress(printer.connectionAddress)) {
    return new VirtualTransport(printer.connectionAddress);
  }
  if (printer.connectionType === "LAN") {
    const target = parseLanAddress(printer.connectionAddress);
    if (!target) throw new PrintTransportError("INVALID_PRINTER_CONFIGURATION", "LAN printers must use a private IPv4 address such as 192.168.1.50:9100");
    return new LanTransport(target.host, target.port);
  }
  return new UsbTransport(printer.connectionAddress);
}
