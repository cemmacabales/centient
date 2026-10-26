// #203: what POST /api/me/event-code can refuse with. Kept free of server
// imports so the event-code card can name each one.
export type RedeemError =
  | "wallet_required"
  | "banned"
  | "rate_limited"
  | "unknown_code"
  | "not_open"
  | "ended"
  | "already_redeemed";
