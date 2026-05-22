import dns from "dns/promises";
const DNS_TIMEOUT_MS = 3_000;
type DnsResult = "valid" | "no_mx" | "error";
export async function verifyDomainExists(domain: string): Promise<DnsResult>{
    const lookup = dns.resolveMx(domain).then((records) => (records.length > 0 ? "valid" : "no_mx") as DnsResult);
    const timeout = new Promise<DnsResult>((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS));
    try{
        return await Promise.race([lookup, timeout]);
    } catch{
        return "error";
    }
}
