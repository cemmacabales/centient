import dns from "dns/promises";
export async function verifyDomainExists(domain: string): Promise<boolean>{
    try{
        const mxRecords = await dns.resolveMx(domain);
        return mxRecords.length > 0;
    } catch{
        return false;
    }
}