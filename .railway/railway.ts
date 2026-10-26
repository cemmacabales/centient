import { defineRailway, github, image, postgres, preserve, project, redis, service, volume } from "railway/iac";

// The whole centient-work project, imported with `railway config pull` (#218).
// Railway doesn't read this file during deploys: changes reach the project only
// through `railway config plan` then `railway config apply`. An apply deletes any
// resource this file leaves out, so every service, database and volume stays
// listed here, including the neutralized payout-reconcile-cron.
// Secrets stay in Railway: preserve() keeps each existing value untouched.

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "asia-southeast1-eqsg3a" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const Redis = redis("Redis", { region: "asia-southeast1-eqsg3a" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 50000 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 50000 });
  const walletHealthCron = service("wallet-health-cron", {
    source: image("alpine:3.21"),
    start: "sh -c 'wget -q -O - --header=\"Authorization: Bearer $CRON_SECRET\" --post-data=\"\" \"https://$WEB_DOMAIN/api/cron/wallet-health\"'",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve(), WEB_DOMAIN: preserve() },
  });
  // No preDeploy: the co-signer must never run migrations (ADR-0001,
  // docs/cosigner-deployment.md).
  const cosigner = service("cosigner", {
    source: github("webnxt-2030/Centient", { branch: "staging", checkSuites: false }),
    build: { buildCommand: "npx prisma generate", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["services/cosigner/**", "lib/stellar/**", "prisma/**", "package.json"] },
    start: "npm run cosign",
    healthcheck: "/health",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    env: { COSIGNER_DAILY_CAP_UNITS: preserve(), COSIGNER_DATABASE_URL: preserve(), COSIGNER_ISOLATION_LEVEL: preserve(), COSIGNER_SHARED_SECRET: preserve(), DATABASE_URL: preserve(), STELLAR_NETWORK: preserve(), STELLAR_POLICY_SIGNER_SECRET: preserve(), STELLAR_USDC_CODE: preserve(), STELLAR_USDC_ISSUER: preserve() },
  });
  const payoutReconcileCron = service("payout-reconcile-cron", {
    source: image("alpine:3.21"),
    start: "sh -c 'echo \"DISABLED: redundant with the in-process reconciler (lib/reconciler.ts). Delete this service.\"; exit 0'",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve(), WEB_DOMAIN: preserve() },
  });
  // Both settings used to come from railway.json. Railpack installs the Node in
  // .node-version (#214); the pre-deploy migrates, then seeds when SEED_ON_DEPLOY=true.
  const web = service("web", {
    source: github("webnxt-2030/Centient", { branch: "staging", checkSuites: true }),
    build: { builder: "RAILPACK" },
    preDeploy: "npx prisma migrate deploy && if [ \"$SEED_ON_DEPLOY\" = \"true\" ]; then npx prisma db seed; else echo 'SEED_ON_DEPLOY not set — skipping seed'; fi",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    domains: ["beta.centient.work", "centient.work"],
    env: { ADMIN_JWT_SECRET: preserve(), ADMIN_SESSION_PASSWORD: preserve(), COSIGNER_ISOLATION_LEVEL: preserve(), COSIGNER_SHARED_SECRET: preserve(), COSIGNER_URL: preserve(), CRON_SECRET: preserve(), DAILY_PAYOUT_CAP_UNITS: preserve(), DATABASE_URL: preserve(), DISCORD_WEBHOOK_URL: preserve(), HEALTH_ALERT_COOLDOWN_MS: preserve(), NEXT_PUBLIC_APP_URL: preserve(), NEXT_PUBLIC_EXPLORER_URL: preserve(), NEXT_PUBLIC_GAMIFICATION: preserve(), NEXT_PUBLIC_LANTERN_ORIGINS: preserve(), NEXT_PUBLIC_POSTHOG_KEY: preserve(), NEXT_PUBLIC_REWARD_AMOUNT: preserve(), NEXT_PUBLIC_REWARD_TOKEN_DECIMALS: preserve(), NEXT_PUBLIC_REWARD_TOKEN_SYMBOL: preserve(), NEXT_PUBLIC_STELLAR_NETWORK: preserve(), NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: preserve(), NIXPKGS_COMMIT: preserve(), NODE_VERSION: preserve(), REDIS_URL: preserve(), RESEND_API_KEY: preserve(), RESEND_EMAIL_FROM: preserve(), SEED_ON_DEPLOY: preserve(), STELLAR_COLD_MIN_RETAIN_UNITS: preserve(), STELLAR_COLD_OPS_SIGNER_PUBLIC: preserve(), STELLAR_COLD_POLICY_SIGNER_PUBLIC: preserve(), STELLAR_COLD_RESERVE_ACCOUNT: preserve(), STELLAR_HOT_FLOAT_TARGET_UNITS: preserve(), STELLAR_HOT_FLOAT_TRIGGER_UNITS: preserve(), STELLAR_NETWORK: preserve(), STELLAR_OPS_SIGNER_SECRET: preserve(), STELLAR_PLATFORM_ACCOUNT: preserve(), STELLAR_POLICY_SIGNER_PUBLIC: preserve(), STELLAR_SPONSOR_SECRET: preserve(), STELLAR_USDC_CODE: preserve(), STELLAR_USDC_ISSUER: preserve() },
  });
  const payoutRetryCron = service("payout-retry-cron", {
    source: image("alpine:3.21"),
    start: "sh -c 'wget -q -O - --header=\"Authorization: Bearer $CRON_SECRET\" --post-data=\"\" \"https://$WEB_DOMAIN/api/cron/payout-retry\"'",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve(), WEB_DOMAIN: preserve() },
  });

  return project("centient-work", {
    resources: [walletHealthCron, Postgres, Redis, cosigner, payoutReconcileCron, web, payoutRetryCron, redisVolume, postgresVolume],
  });
});
