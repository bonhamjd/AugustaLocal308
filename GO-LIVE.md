# Go-live checklist

Everything in order. Nothing here is optional except where it says so.

---

## 1. Fix the thing that is silently broken

**Symptom:** members enter their email, the site says "a login link is on its
way," nothing ever arrives.

**Cause:** `RESEND_FROM` is unset, so the code falls back to
`onboarding@resend.dev`. Resend returns 403 for every recipient except your own
Resend account address. The old code logged that 403 and told the member the
link was sent anyway.

**Fix:**

- [ ] Resend > Domains > add `augustalocal308.com`
- [ ] Add the DKIM/SPF records Resend gives you at your DNS host
- [ ] Wait for status `verified`
- [ ] Netlify env var `RESEND_FROM` = `Augusta Local 308 <noreply@augustalocal308.com>`
- [ ] Open `/.netlify/functions/diag?key=<SESSION_SECRET>` and confirm zero warnings

The new code returns a real error instead of lying, so this cannot hide again.

---

## 2. Environment variables

In Netlify > Project configuration > Environment variables:

- [ ] `SESSION_SECRET` — long random string. Generate: `openssl rand -hex 32`
- [ ] `STRIPE_RESTRICTED_KEY` — restricted key, **Customers: Read** and
      **Subscriptions: Read** only. Not a secret key.
- [ ] `RESEND_API_KEY`
- [ ] `RESEND_FROM` — see above
- [ ] `CALCOM_API_KEY`
- [ ] `CALCOM_WEBHOOK_SECRET` — make up a long random string, you paste the same
      one into Cal.com in step 3
- [ ] `MEMBER_ALLOWLIST` — `bonham.jd@gmail.com` plus any comps.
      **Without this you cannot book your own bay.**

Then check `/.netlify/functions/diag?key=<SESSION_SECRET>`.

---

## 3. Close the Cal.com hole

Right now anyone who finds `cal.com/al308/bookbay` can book. The site's login
form does not stop them.

- [ ] Cal.com > Event type `bookbay` > Advanced > **Requires confirmation: ON**
- [ ] Cal.com > Event type `bookbay` > **Hidden** (keeps it off your public profile)
- [ ] Cal.com > Settings > Webhooks > New
      - URL: `https://augustalocal308.com/.netlify/functions/cal-webhook`
      - Secret: the same string as `CALCOM_WEBHOOK_SECRET`
      - Trigger: **Booking Requested**
- [ ] Set booking limits while you are in there: minimum notice, buffer between
      bookings, max bookings per day, and your actual open hours

**Test it:** book from an email with no membership. You should get a decline
email within seconds. Then book from a member email. It should confirm itself.

---

## 4. Test everything before the domain moves

The domain still points at the old Weebly site, so
`augustalocal308.netlify.app` is your test site right now. Use it.

- [ ] Stripe in **test mode**: run each of the six payment links end to end
      (Family yearly, Single yearly, Family monthly, Single monthly, hoodie,
      t-shirt, gift membership) with card `4242 4242 4242 4242`
- [ ] Confirm the test subscription shows as `active` in Stripe
- [ ] Log in with that test customer's email. Link arrives, session works.
- [ ] Confirm "Who's on the sim" shows bookings with first name and last initial
- [ ] Book a bay as that member. It auto-confirms.
- [ ] Cancel the test subscription in Stripe, reload the page. You should be
      kicked back to the login form. **This is your unpaid-member lever.**
- [ ] Try to book from a non-member email. Declined.
- [ ] Open the site on your phone. Check the nav row, the membership cards, and
      the booking embed.
- [ ] Confirm the Stripe Customer Portal link in the footer opens and lets a
      member update their card
- [ ] Switch Stripe to **live mode** and confirm all seven payment links in the
      HTML are live-mode links, not test-mode links

---

## 5. Migrate existing members

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

---

## 6. Move the domain

- [ ] Netlify > Domain management > add `augustalocal308.com` and `www`
- [ ] Update DNS at your registrar to Netlify's records
- [ ] Wait for the Netlify SSL certificate to issue
- [ ] Confirm `https://augustalocal308.com` loads the new site, not Weebly
- [ ] Confirm `http://` and `www` both redirect to `https://augustalocal308.com`
- [ ] Re-test one login on the real domain (the magic link uses the site URL)
- [ ] Cancel Square/Weebly hosting once you are satisfied, not before

---

## 7. Gaps worth closing before you open the doors

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
- [ ] **Swag deadline is stale.** "Pre-order. To the printer 8/31." is in the
      past and is live on the page right now. Update the date or pull the line.
      `public/index.html` line 113.
- [ ] **League standings.** The button is a label until you publish the Google
      Sheet. Instructions are in an HTML comment right above it.
- [ ] **Google Business Profile.** Free, and it is how people in Franklin find
      you. The site now has the structured data to match.
- [ ] **Cancellation policy.** What happens when someone cancels mid-year on an
      $850 plan? Decide before it happens, not during.

---

## 8. Optional, not required

- Analytics: one lightweight tag if you want traffic numbers. Skip if you don't.
- Login link is currently reusable within its 15 minute window. Single-use
  tokens need somewhere to store used IDs. Low risk for a golf club.
- No rate limit on the login form. Someone could hammer it and burn Stripe API
  calls. Add Netlify rate limiting if it ever becomes a problem.
