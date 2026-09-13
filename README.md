# Augusta Local 308

Members-only indoor golf in Franklin, Nebraska. One static page, a private
dashboard, and a handful of Netlify Functions. No framework, no build step.

Live: https://augustalocal308.netlify.app (domain cutover pending)
Deploys: push to `main` on GitHub, Netlify builds it.

## What it does

1. A member logs in with **email and password** at the top of the page.
2. The site asks Stripe whether that email still has an active subscription.
   **Stripe is the member database.** There is no user table to keep in sync,
   and letting a subscription lapse cuts access on the next page load.
3. Logged in, the member sees open times, taps one, and it is booked. Their name
   and email come off the session, so there is nothing to type.
4. `/admin` shows JD who is paying, what came in each month, and who is actually
   using the place.

## Layout

```
public/
  index.html          the whole public site, reserve panel first
  admin.html          the dashboard, gated by the admin function
  uploads/            images
netlify/functions/
  _shared.js          env, tokens, passwords, Stripe, Cal.com. Start here.
  _store.js           Netlify Blobs wrapper. Password hashes and display names.
  login.js            email + password -> session cookie
  request-login.js    emails a one-time link (first login, forgot password)
  verify-login.js     the link lands here, issues the session
  set-password.js     sets or changes a password
  profile.js          the name shown on the shared calendar
  me.js               who am I, do I have a password, my bookings
  slots.js            open times from Cal.com, members only
  book.js             creates and confirms the booking
  cancel.js           cancels, only your own
  schedule.js         who's on the sim, masked names, no emails
  cal-webhook.js      declines anyone who books via cal.com directly
  admin.js            the dashboard numbers
  diag.js             config check, see below
test/smoke.js         64 offline checks. Run before every push.
```

## The two things the site stores

Netlify Blobs holds one small record per member: a scrypt password hash and the
name they want on the calendar. Keys are a SHA-256 of the email, never the email
itself, so the blob listing is not a member roster. Everything else -- who is a
member, what they pay, when they play -- lives in Stripe and Cal.com.

## Running the tests

```
node test/smoke.js
```

No network, no Netlify, no Blobs. Stripe, Cal.com and Resend are stubbed and the
store runs in memory. This proves the logic. It cannot prove a live key works.

## When something "works" but nothing happens

```
https://augustalocal308.com/.netlify/functions/diag?key=<SESSION_SECRET>
```

Reports whether each secret is set and whether each service answers. Never
prints a secret. Not linked from anywhere.

## Environment variables

| Name | Required | What it is |
|---|---|---|
| `SESSION_SECRET` | yes | Signs the session cookie. `openssl rand -hex 32` |
| `STRIPE_RESTRICTED_KEY` | yes | Read-only: Customers, Subscriptions, Charges |
| `CALCOM_API_KEY` | yes | Reads availability, creates and cancels bookings |
| `CALCOM_WEBHOOK_SECRET` | yes | Verifies the Cal.com webhook signature |
| `RESEND_API_KEY` | yes | Sends first-login and forgot-password links |
| `RESEND_FROM` | yes | Must be a domain verified in Resend |
| `MEMBER_ALLOWLIST` | yes | Comps and the owner. JD has no Stripe subscription |
| `ADMIN_EMAILS` | yes | Who can open `/admin`. Falls back to the allowlist |
| `CALCOM_USERNAME` | no | Default `al308` |
| `CALCOM_EVENT_SLUG` | no | Default `bookbay` |
| `CALCOM_EVENT_TYPE_ID` | no | Use instead of username + slug |
| `CLUB_TIMEZONE` | no | Default `America/Chicago` |

## Cal.com API versions

Cal.com pins a different version per endpoint family. These are set in
`_shared.js` and are the only versions this code is written against:

- `GET /v2/bookings` — `2026-05-01`
- `POST /v2/bookings`, `/confirm`, `/decline`, `/cancel` — `2026-02-25`
- `GET /v2/slots` — `2024-09-04`

## Dashboard colors

The bar charts do not use the brand yellow. `#fce300` sits at OKLCH lightness
0.91, too light to read as a data mark on the dark surface. The two data hues
(`#c98500` gold, `#3987e5` blue) were validated against the panel surface
`#101211` for colorblind separation and contrast. Brand yellow stays on
headings, links and buttons. If you change one, re-validate the pair.

## Go live

See `GO-LIVE.md`.
