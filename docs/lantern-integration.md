# Lantern integration

Centient can sign contributors in with **Lantern**, the Android Stellar wallet
(`com.lantern.wallet`), and set up their USDC payouts through it. Centient's side
is built and live. Lantern 0.5.1 was missing four things before it could work
on a phone; this page is the spec for them. For what Lantern 0.6.0 ships, see
[Lantern 0.6.0](#lantern-060).

## How it works

1. A contributor opens centient.work in Chrome on an Android phone that has
   Lantern. Centient shows **Open in Lantern** instead of the Freighter button.
2. Tapping it hands `https://centient.work/` to Lantern, which opens it in its
   Apps tab.
3. Inside Lantern, Centient shows **Connect Lantern**. It asks for the public key
   (`lantern:getPublicKey`), then a signature over a one-time challenge
   (`lantern:signMessage`), and the contributor is signed in.
4. Payout setup asks Lantern to co-sign a transaction Centient has already
   built and signed as sponsor (`lantern:signXdr`). Centient pays the network
   fee and the reserves, so the contributor needs no XLM.

iOS and desktop never see any of this. Freighter stays available everywhere.

## What Lantern needs to add

### 1. Let Chrome see that Lantern is installed

Centient asks `navigator.getInstalledRelatedApps()`, and Chrome only answers
for an app that declares the site. Centient is served from both
`https://centient.work` and `https://beta.centient.work`, so declare both;
Chrome on a host that isn't listed never reports Lantern, and "Open in Lantern"
stays hidden there. Add this to `AndroidManifest.xml`, inside `<application>`:

```xml
<meta-data android:name="asset_statements" android:resource="@string/asset_statements" />
```

and this to `res/values/strings.xml`:

```xml
<string name="asset_statements">
[{
  \"relation\": [\"delegate_permission/common.handle_all_urls\"],
  \"target\": { \"namespace\": \"web\", \"site\": \"https://centient.work\" }
}, {
  \"relation\": [\"delegate_permission/common.handle_all_urls\"],
  \"target\": { \"namespace\": \"web\", \"site\": \"https://beta.centient.work\" }
}]
</string>
```

Centient's web manifest, served on both hosts, already names
`com.lantern.wallet` in `related_applications`; the two together are what
Chrome checks. Lantern 0.6.0 generates these statements from its directory, so
listing both origins there (see [Lantern 0.6.0](#lantern-060)) produces this.

### 2. A link that opens a URL in the Apps tab

Centient links to:

```
intent://open?url=<encoded https URL>#Intent;scheme=lantern;package=com.lantern.wallet;S.browser_fallback_url=<same URL>;end
```

so Lantern's `MainActivity` needs an intent filter Chrome is allowed to fire:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="lantern" android:host="open" />
</intent-filter>
```

On launch, and on `App.addListener("appUrlOpen")`, read `url`, check it is
`https:`, and open it the way a URL typed into the Apps tab opens. Unlock first
if the wallet is locked.

### 3. Let a framed dApp keep a session

Lantern frames external dApps with
`sandbox="allow-scripts allow-forms allow-popups"`. Without
`allow-same-origin`, the page has no origin of its own: it can't keep a
cookie or call its own API, so Centient can't sign anyone in. Two changes:

- add `allow-same-origin` to that sandbox (it lets the page act as its *own*
  origin, never Lantern's, so it still can't reach Lantern's storage or keys);
- in the Android shell, allow third-party cookies for the webview:
  `CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)`.

Centient sets a partitioned (`Partitioned; SameSite=None; Secure`) cookie for
sessions started inside Lantern, so it is stored under Lantern's partition and
is never sent anywhere else.

### 4. `lantern:signXdr`: co-sign without submitting

Payout setup needs the contributor's signature added to an envelope Centient
built. `lantern:signAndSubmit` can't do that: it takes a payment intent and
builds its own transaction. Lantern's signer already has `SIGN_ONLY`. Expose
it to dApps:

| dApp sends | Lantern replies |
|---|---|
| `{ type: "lantern:signXdr", xdr, networkPassphrase }` | `{ type: "lantern:signing" }` at once, then `{ type: "lantern:xdrSigned", signedXdr }`, or `{ type: "lantern:signRejected", error? }` |

Show the same approval sheet as `signAndSubmit`, and refuse a
`networkPassphrase` that isn't the wallet's current network. Reply with
`lantern:signing` straight away: Centient treats no acknowledgement within 5
seconds as "this Lantern can't sign transactions" rather than waiting.

## What Centient already handles

- **Message signing as Lantern does it.** Lantern signs
  `"Lantern signed message:\n" + message` raw, not SEP-53, so no Lantern change
  is needed there.
- **Network ids.** `"TESTNET"` / `"PUBLIC"`, as Lantern sends them.
- **Embedding.** Lantern's origins are allowed by `frame-ancestors`. Centient
  only trusts messages from the framing window at a listed origin.

## Turning it on

Set `NEXT_PUBLIC_LANTERN_ORIGINS` on `web` to

```
https://android.golantern.xyz chrome-extension://iflpkjgolcbleombhldiibhojohjpnmd
```

and redeploy (it is inlined at build time). The response should then carry
`frame-ancestors 'self' https://android.golantern.xyz chrome-extension://iflpkjgolcbleombhldiibhojohjpnmd`.
The first is Lantern's Android webview, the second its Chrome extension, whose
id Lantern pins with a manifest `key` so every install shares it (#197). Unset, none of this
exists: the CSP frames only Centient, and no Lantern UI renders.

Don't list `https://localhost`. It was Lantern's Android origin up to 0.5.x, but
it is Capacitor's default and every Capacitor app on the phone shares it, so
listing it lets any of them frame Centient and pass the bridge's origin check.
Under Lantern 0.6.0, a deployment that lists only `https://localhost` won't
load in the Apps tab (`net::ERR_BLOCKED_BY_RESPONSE`).

Not listed on purpose:

- `https://app.golantern.xyz`, Lantern's browser build for iPhone users. It
  only runs Lantern's bundled mini-apps, not remote dApps, so it never frames
  Centient.
- `chrome-extension:` on its own, or any id other than Lantern's pinned one.
  Allowing the whole scheme would let any installed extension frame Centient
  and pass the bridge's origin check, so `parseLanternOrigins` keeps only a
  full 32-letter id.

## Lantern 0.6.0

Lantern 0.6.0 moved its Android webview to `https://android.golantern.xyz`. It
ships `lantern://open` (change 2) and `lantern:signXdr` (change 4), and
generates the `asset_statements` (change 1), but both `lantern://open` and the
`asset_statements` are driven by Lantern's curated directory. Until
Centient is listed there, Lantern refuses the "Open in Lantern" link (the page
stays in the browser) and Chrome doesn't report Lantern as installed, so
contributors on Android see the Freighter path. Opening Centient from the Apps
tab by hand works as soon as the origin above is set.

Lantern posts bridge replies to the exact origin its directory lists, so each
entry has to be an origin contributors end up on after any redirects.
`centient.work` and `beta.centient.work` both serve the app directly (neither
redirects), so Centient asks Lantern to list **both**: `https://centient.work/`
and `https://beta.centient.work/`, as two entries or one entry carrying both
origins (#192). Centient needs nothing more for that. Its bridge checks only
the framing origin, never its own, and "Open in Lantern" hands over the current
page's URL, so each domain opens itself. Sessions are per domain, but both
share one database, so the same wallet reaches the same account on either.

## Tested

Lantern 0.5.1's own web bundle, served locally with changes 3 and 4 patched in,
ran Centient inside its Apps tab end to end on testnet (2026-10-02). It
connected, signed in with a Lantern signature, and set up payouts: the new
wallet's account and USDC trustline were created, sponsored by Centient, with
the wallet holding 0 XLM. Changes 1 and 2 need the Android build and a phone,
so "Open in Lantern" was checked against a stubbed `getInstalledRelatedApps`.
