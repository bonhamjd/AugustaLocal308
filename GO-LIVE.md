# Go-live checklist

Everything in order. Nothing here is optional except where it says so.

---

## 1. The Stripe key, explained

You asked what "full access to Stripe" means. Here is the plain version.

A **secret key** (`sk_live_...`) can do anything your Stripe login can do: charge
cards, issue refunds, move money to a bank account, delete customers. That key
should never leave your own browser.

A **restricted key** (`rk_live_...`) is a key you build yourself by checking
boxes. Each box is one thing, and each box is set to None, Read, or Write. The
site's key only ever needs **Read**. A read-only key cannot charge anyone, cannot
refund anyone, cannot move a dollar, and cannot change a single record. The
worst case if it leaked is that someone could see your member list and your
revenue numbers. That is bad, not catastrophic, and you fix it by clicking
Revoke.

**Build the key:**

1. Stripe Dashboard, top right, **Developers** (or the `...` menu) → **API keys**
2. Scroll to **Restricted keys** → **Create restricted key**
3. Name it `augustalocal308-site`
4. Set exactly these to **Read**, and leave every other row on **None**:

   | Permission | Read | Why the site needs it |
   |---|---|---|
   | Customers | yes | Match a login email to a person |
   | Subscriptions | yes | Decide if that person is still paying |
   | Charges | yes | The revenue numbers on the dashboard |

5. Create the key, copy it once (Stripe shows it one time)
6. Netlify → your project → **Project configuration → Environment variables** →
   set `STRIPE_RESTRICTED_KEY` to that value
7. Mark it **secret** in Netlify while you are in there. Right now your keys are
   stored as plain values, which means anyone with dashboard access can read them.
8. Revoke the old key

Charges: Read is the only new one. Without it the whole site still works, the
dashboard just shows a note where revenue would be.

- [ ] New restricted key created with those three Read permissions
- [ ] `STRIPE_RESTRICTED_KEY` updated in Netlify and marked secret
- [ ] Old key revoked

---

## 2. Fix the thing that is silently broken

**Symptom:** members enter their email, the site says "a login link is on its
way," nothing ever arrives.

**Cause:** `RESEND_FROM` is unset, so the code falls back to
`onboarding@resend.dev`. Resend returns 403 for every recipient except your own
Resend account address.

This matters less than it used to, because members now log in with a password.
Email is only used the first time and for a forgotten password. It still has to
work.

- [ ] Resend → Domains → add `augustalocal308.com`
- [ ] Add the DKIM/SPF records Resend gives you at your DNS host
- [ ] Wait for status `verified`
- [ ] Netlify env var `RESEND_FROM` = `Augusta Local 308 <noreply@augustalocal308.com>`
- [ ] Open `/.netlify/functions/diag?key=<SESSION_SECRET>` and confirm zero warnings

---

## 3. Environment variables

In Netlify → Project configuration → Environment variables:

- [ ] `SESSION_SECRET` — long random string. Generate: `openssl rand -hex 32`
- [ ] `STRIPE_RESTRICTED_KEY` — see section 1
- [ ] `RESEND_API_KEY`
- [ ] `RESEND_FROM` — see section 2
- [ ] `CALCOM_API_KEY`
- [ ] `CALCOM_WEBHOOK_SECRET` — make up a long random string, you paste the same
      one into Cal.com in step 4
- [ ] `MEMBER_ALLOWLIST` — `bonham.jd@gmail.com` plus any comps.
      **Without this you cannot book your own bay.**
- [ ] `ADMIN_EMAILS` — who can open `/admin`. Just `bonham.jd@gmail.com` unless
      you want Zach in there too. If you leave it blank it falls back to
      `MEMBER_ALLOWLIST`, which means every comped member could read your
      revenue. Set it.

Optional, only if your Cal.com setup differs from the defaults:

- `CALCOM_USERNAME` (default `al308`)
- `CALCOM_EVENT_SLUG` (default `bookbay`)
- `CALCOM_EVENT_TYPE_ID` — use this instead of the two above if the slug ever changes
- `CLUB_TIMEZONE` (default `America/Chicago`)

Then check `/.netlify/functions/diag?key=<SESSION_SECRET>`.

---

## 4. Cal.com settings

The site now draws its own calendar and books through the Cal.com API, so
members never see a Cal.com form. Two settings still matter:

- [ ] Event type `bookbay` → **Advanced** → delete every booking question except
      name and email. **If there is a required "address" or "phone" question,
      booking through the site will fail.** This is the setting that was making
      members type their address.
- [ ] Event type `bookbay` → **Advanced** → Requires confirmation: **ON**
      (this is what stops a stranger who finds `cal.com/al308/bookbay`; the site
      confirms member bookings instantly on its own, so members never wait)
- [ ] Event type `bookbay` → **Hidden** (keeps it off your public Cal.com profile)
- [ ] Settings → Webhooks → New
      - URL: `https://augustalocal308.com/.netlify/functions/cal-webhook`
      - Secret: the same string as `CALCOM_WEBHOOK_SECRET`
      - Trigger: **Booking Requested**
- [ ] Set your real open hours, minimum notice, buffer between bookings, and max
      bookings per day. Whatever you set here is exactly what members see.

---

## 5. Test everything before the domain moves

The domain still points at the old Weebly site, so
`augustalocal308.netlify.app` is your test site right now. Use it.

**Offline first.** From the project folder, run `node test/smoke.js`. 64 checks
should pass. That covers the logic. It cannot test a live API key.

**Then on the test site:**

- [ ] Stripe in **test mode**: run each payment link end to end with card
      `4242 4242 4242 4242`
- [ ] Confirm the test subscription shows as `active` in Stripe
- [ ] On the site, click "First time, or forgot your password? Email me a link",
      enter that test email, open the link
- [ ] You land on the site with a yellow "Set a password" box. Set one.
- [ ] Log out. Log back in with email and password. No email involved.
- [ ] Pick a day, pick a time, book it. **You should never be asked for a name or
      an address.** It should say "Booked. See you there."
- [ ] Confirm the booking shows in Cal.com as confirmed, not pending
- [ ] Confirm "Who's on the sim" shows first name and last initial, no emails
- [ ] Cancel it from the site. Confirm it disappears from Cal.com.
- [ ] Cancel the test subscription in Stripe, reload the page. You should be
      kicked back to the login form. **This is your unpaid-member lever.**
- [ ] Try to book from `cal.com/al308/bookbay` with a non-member email. Declined.
- [ ] Open `/admin` as yourself. Numbers should load.
- [ ] Open `/admin` as the test member. You should get "Not found."
- [ ] Open the site on your phone. Check the day strip scrolls and the times fit.
- [ ] Switch Stripe to **live mode** and confirm all seven payment links in the
      HTML are live-mode links

---

## 6. Migrate existing members

Stripe subscriptions cannot be moved between processors by copying a
spreadsheet. You have two honest options:

**Option A, cleanest:** email every current member a Stripe payment link, ask
them to re-subscribe, cancel the old billing once they have. Roughly one
evening of texting for a club this size. No gap if you leave the old billing
running until the new one starts.

**Option B:** if cards are stored with another processor, both Stripe and most
processors support a PCI-compliant card data migration between them. It is a
support request on both sides, not something you can do yourself, and it takes
days to weeks. Worth it only if you have enough members that re-signup is
painful.

- [ ] Decide A or B
- [ ] Build the list: every current member's name, email, plan, renewal date
- [ ] Make sure the email you use for Stripe is the email they will type to log
      in. **A mismatch here is what causes "user gaps."** Same email or no access.
- [ ] Add anyone paying by check or comped to `MEMBER_ALLOWLIST`
- [ ] After migration, compare the Stripe customer list against your roster line
      by line before you cancel anything
- [ ] Send one text to all twenty: the site address, "click Email me a link the
      first time, then set a password." That is the whole instruction.

---

## 7. Move the domain

- [ ] Netlify → Domain management → add `augustalocal308.com` and `www`
- [ ] Update DNS at your registrar to Netlify's records
- [ ] Wait for the Netlify SSL certificate to issue
- [ ] Confirm `https://augustalocal308.com` loads the new site, not Weebly
- [ ] Confirm `http://` and `www` both redirect to `https://augustalocal308.com`
- [ ] Re-test one login on the real domain
- [ ] Cancel Square/Weebly hosting once you are satisfied, not before

---

## 8. Gaps worth closing before you open the doors

Things the site does not handle today:

- [ ] **Liability waiver.** People swing clubs in your building unsupervised.
      Ask your insurance agent what they need. A one-page e-sign at signup is
      the usual answer. This is the biggest open item on the list.
- [ ] **Door code process.** Nothing on the site issues or revokes codes. Write
      down how a new member gets one and how you pull it when they lapse, even
      if it stays a text message.
- [ ] **Guest fee.** The site says $20 per guest but there is no way to pay it.
      Add a Stripe payment link.
- [ ] **Gift membership fulfillment.** Someone buys the gift link. What happens
      next? Right now, nothing automatic.
- [ ] **Swag deadline.** "To the printer 8/31" is gone from the page, but the
      Swag section still says "Pre-order" with no date. Put a real one in
      `public/index.html` or pull the line.
- [ ] **League standings.** The button is a label until you publish the Google
      Sheet. Instructions are in an HTML comment right above it.
- [ ] **Google Business Profile.** Free, and it is how people in Franklin find
      you. The site has the structured data to match.
- [ ] **Cancellation policy.** What happens when someone cancels mid-year on an
      $850 plan? Decide before it happens, not during.

---

## 9. Optional, not required

- Analytics: one lightweight tag if you want traffic numbers. Skip if you don't.
- Login links are reusable within their 15 minute window. Single-use tokens are
  possible now that the site has a store, but the window is short and the link
  goes to the member's own inbox. Low risk for a golf club.
- The login form is rate limited per email (five wrong passwords, fifteen minute
  lockout) but not per IP. Add Netlify rate limiting if it ever matters.
