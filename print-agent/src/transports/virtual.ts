import { getVirtualPrinterAdapter, parseVirtualAddress, VirtualPrinterAdapter } from "@/lib/print/virtual-printer";
import type { Transport } from "./types";

/**
 * Virtual printer transport for development, CI and emulator testing (DEV-PRINT-01).
 * Routes print bytes and reachability probes directly to the VirtualPrinterAdapter.
 */
export class VirtualTransport implements Transport {
  readonly adapter: VirtualPrinterAdapter;

  constructor(address: string, tenantId?: string) {
    const parsed = parseVirtualAddress(address);
    const resolvedTenant = tenantId ?? parsed.tenantId ?? process.env.FLOWDINEOS_TENANT_ID ?? "default";
    this.adapter = getVirtualPrinterAdapter(resolvedTenant, address);
  }

  async send(bytes: Buffer): Promise<void> {
    await this.adapter.send(bytes);
  }

  async probe(): Promise<void> {
    await this.adapter.probe();
  }
}
