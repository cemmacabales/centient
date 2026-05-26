export function isValidPassword(password: string): boolean {
    if (password.length < 8 || password.length > 128) return false;
    if (!/\d/.test(password)) return false;
    if (!/\W/.test(password)) return false;
    return true;
}
export function isValidEmail (email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) return false;
    const domain = email.split("@")[1];
    const domainParts = domain.split(".");
    const domainName = domainParts[0];
    if (domainName.length < 2 || /^\d+$/.test(domainName)) return false;
    return true;
}
