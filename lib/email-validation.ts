import dns from "dns/promises";
const DNS_TIMEOUT_MS = 3_000;
type DnsResult = "valid" | "no_mx" | "error";
export async function verifyDomainExists(domain: string): Promise<DnsResult>{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
    try{
        const mxRecords = await (dns.resolveMx as any)(domain, { signal: controller.signal});
        return mxRecords.length > 0 ? "valid" : "no_mx";
    } catch{
        return "error";
    } finally{
        clearTimeout(timer);
    }
}
