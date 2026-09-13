# Augusta Local 308 — augustalocal308.com

Members-only indoor golf in Franklin, Nebraska. One static page plus five small
serverless functions. No framework, no npm install, no build step.

```
public/index.html          the entire site
public/uploads/            images (webp)
netlify/functions/         serverless functions
  _shared.js               env names, tokens, membership check, Cal.com client
  request-login.js         POST email -> emails a magic link if they're a member
  verify-login.js          magic link lands here -> sets a 30 day session cookie
  me.js                    who am I, am I still paid up, my bookings
  schedule.js              the members calendar: who is on the sim, masked names
  cal-webhook.js           the real booking gate (confirm members, decline others)
  logout.js                clears the cookie
test/smoke.js              offline tests, no network. node test/smoke.js
netlify.toml               publish dir, functions dir, headers
```

## How membership works

Stripe is the source of truth. There is no user database.

1. Member enters their email on the site.
2. `request-login` asks Stripe whether that email has an `active` or `trialing`
   subscription. If yes, it emails a signed link that expires in 15 minutes.
3. `verify-login` sets an HttpOnly session cookie good for 30 days.
4. Every protected call re-checks Stripe. **Stop paying and access stops on the
   next page load.** That is the lever for pulling someone's access.

`MEMBER_ALLOWLIST` covers anyone who should have access without a Stripe
subscription: JD himself, comps, anyone who pays by check. Without it JD cannot
log in or book his own bay.

## How booking is actually gated

The login form only hides the Cal.com embed on the page. `cal.com/al308/bookbay`
is a public URL and always will be. So the gate is server side:

- The `bookbay` event type has **Requires confirmation** turned ON, so every
  booking starts as pending.
- Cal.com fires a `BOOKING_REQUESTED` webhook at `cal-webhook`.
- `cal-webhook` verifies the signature, checks the attendee email against
  Stripe plus the allowlist, then confirms or declines.
- If Stripe is unreachable the booking is left pending rather than declined, so
  a paying member never gets bounced by an outage. It shows up unconfirmed in
  Cal.com for JD to approve by hand.

A non-member who finds the direct link gets a decline email pointing them at
the membership page and JD's phone number.

## Environment variables (Netlify > Project configuration > Environment variables)

| Variable | What it is | If it's missing |
| --- | --- | --- |
| `SESSION_SECRET` | Long random string. Signs login and session tokens. | Nobody can log in. |
| `STRIPE_RESTRICTED_KEY` | Stripe restricted key, `Customers: Read` + `Subscriptions: Read` only. | Nobody can log in. |
| `RESEND_API_KEY` | Resend API key. | No login emails. |
| `RESEND_FROM` | `Augusta Local 308 <noreply@augustalocal308.com>` | **Falls back to `onboarding@resend.dev`, which Resend only delivers to your own account address. Every other member gets nothing and no error.** |
| `CALCOM_API_KEY` | Cal.com API key, starts `cal_`. | No calendar, no auto-confirm. |
| `CALCOM_WEBHOOK_SECRET` | Same string you paste into the Cal.com webhook. | `cal-webhook` refuses to run and booking is ungated. |
| `MEMBER_ALLOWLIST` | Comma separated emails that bypass Stripe. | JD cannot book. |

Legacy names `Stripe_Restricted_Key`, `Cal_Netlify_Key` and `Resend_Api_Key`
are still read as fallbacks.

## When something "works" but nothing happens

```
https://augustalocal308.com/.netlify/functions/diag?key=<SESSION_SECRET>
```

Reports which variables are set (never their values), pings Stripe, Cal.com and
Resend, lists your verified Resend domains, and warns about the specific traps
above. Returns 404 without the right key.

Function logs: Netlify > Logs > Functions. Every function logs with a
`[function-name]` prefix.

## Working on it

Edit, commit, push. Netlify builds on push.

- Push to a **branch** and Netlify gives you a preview URL. Test there.
- Merge to `main` only when the preview is right. `main` is the live site.
- Netlify > Deploys > any older deploy > "Publish deploy" rolls back instantly.

Before pushing: `node test/smoke.js` (no network needed, no install needed).

## House rules for this codebase

- **Inline styles stay inline.** No stylesheet, no framework, no component
  library. One file you can read top to bottom beats a build system.
- Keep the `data-stack`, `data-stack-2`, `data-hero`, `data-cell`,
  `data-navbar`, `data-navlinks` attribute hooks. The responsive layout hangs
  off them.
- No sliders, scroll animations, popups, chat widgets. One analytics tag at
  most, if ever.
- Every tap target at least 44px tall.
- Images: webp, compressed, about 1600px wide. Below the fold gets
  `loading="lazy"`.
- Secrets live in Netlify environment variables. Never in this repo.
- Anything member-related is decided in a function, never with `display:none`.

## Brand

- Ground `#0a0b0b` · Panels `#131514` / `#101211` · Rules `#242724` / `#2d302c`
- Text `#f4f4f1` · Muted `#b4b8b3`, `#9ba09a`, `#83887f`
- Accent `#fce300`, hover `#fff48a`, text on yellow `#0a0b0b`
- Archivo, weights 400/700/800/900. Flush left. Square corners, nothing rounded.

## Business facts

- Augusta Local 308, 1516 L St, Franklin, NE 68930
- JD Bonham, 402-215-7000 call or text, bonham.jd@gmail.com
- Uneekor simulator, 4K projector, 15 foot screen, two 75 inch TVs, room for 16+
- Memberships: Yearly Family $850, Yearly Single $550, Monthly Family $75,
  Monthly Single $50
- Guests $20 per person, always with a member
