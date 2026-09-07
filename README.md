# Augusta Local 308 — website handoff

Static, dependency-free site. `index.html` plus `uploads/`. No build step, no framework, no npm.
Open `index.html` in a browser to see the finished design.

## Brand

- Ground: `#0a0b0b` · Panel: `#131514` / `#101211` · Rules: `#242724` / `#2d302c`
- Text: `#f4f4f1` · Muted: `#b4b8b3`, `#9ba09a`, `#83887f`
- Accent (logo yellow): `#fce300`, hover `#fff48a`, text on yellow `#0a0b0b`
- Type: Archivo (Google Fonts), weights 400/700/800/900. Flush left everywhere. Square corners, no rounded anything.
- Members only. Guests are $20 per person and must come with a member.

## Business facts

- Augusta Local 308, 1516 L St, Franklin, NE 68930
- JD Bonham, 402-215-7000 (call or text), bonham.jd@gmail.com
- Uneekor simulator, 4K projector, 15 foot screen, two 75 inch TVs, room for 16+
- Memberships: Yearly Family $850, Yearly Single $550, Monthly Family $75, Monthly Single $50
- Swag: Hoodie $50 → $45 (low stock), T-shirt $22. Pre-orders to the printer 8/31.

## Placeholders to replace

Search `index.html` for these exact strings:

| Placeholder | Replace with |
| --- | --- |
| `JOIN_URL` | Stripe payment link for memberships |
| `BOOKING_URL` | Google booking / reservation link |
| `SHOP_URL` | Stripe payment link for swag |
| `STANDINGS_URL` | Google Sheet published web page with league standings |
| `HOODIE PHOTO` / `T-SHIRT PHOTO` | real product photos in the two swag tiles |
| Calendar comment in `#reserve` | Google Calendar embed iframe (instructions are in the comment) |

## Notes for the developer

- All styling is inline on purpose. Do not extract it into a stylesheet or a component library unless the site grows.
- The only CSS in `<head>` is body reset, hover/focus states, and three responsive media queries (940px and 600px). Grids collapse via the `data-stack`, `data-stack-2`, `data-hero`, `data-cell` attributes. Keep those attribute hooks if you refactor.
- Performance matters more than features here. Below-fold images are already `loading="lazy"`. Do not add sliders, scroll animations, popups, chat widgets, or analytics beyond one lightweight tag.
- Keep every tap target at least 44px tall.
- Photos should be compressed and, ideally, served as WebP at roughly 1600px wide.

## Deploy

Any static host. Netlify or Vercel drag-and-drop is fine. Point `augustalocal308.com` at it.
