import dns from "dns/promises";
const DNS_TIMEOUT_MS = 3_000;
export async function verifyDomainExists(domain: string): Promise<boolean>{
    try{
        const mxRecords = await Promise.race([
            dns.resolveMx(domain), 
            new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS)
            )
        ]);
        return mxRecords.length > 0;
    } catch{
        return false;
    }
}