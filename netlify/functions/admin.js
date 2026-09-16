// The numbers, in one call. JD only.
//
// Three questions this answers:
//   Who is paying and who is not, right now.
//   What came in each month, membership versus everything else.
//   Who is actually using the place, and who has gone quiet.
//
// Every Stripe call here is read only. If a scope is missing the dashboard
// still loads and says which part is dark, rather than failing whole.

const {
  ENV, stripeList, entryList, isAdmin, planLabel, periodEnd, calAllBookings, requireActiveSession, json,
} = require('./_shared');
const store = require('./_store');

const ACTIVE = ['active', 'trialing'];
const AT_RISK = ['past_due', 'unpaid', 'incomplete'];

function monthKey(unixOrIso) {
  const d = typeof unixOrIso === 'number' ? new Date(unixOrIso * 1000) : new Date(unixOrIso);
  return d.toISOString().slice(0, 7);
}

function monthsBack(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}

function monthlyValue(amount, interval) {
  if (!amount) return 0;
  if (interval === 'year') return Math.round(amount / 12);
  if (interval === 'week') return Math.round((amount * 52) / 12);
  return amount;
}

exports.handler = async (event) => {
  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[admin] membership check failed:', e.message);
    return json(502, { error: 'membership_check_failed' });
  }
  // A non-admin gets the same answer as a stranger. No hint that /admin exists.
  if (!session || !isAdmin(session.email)) return json(404, { error: 'not_found' });

  const p = event.queryStringParameters || {};
  const months = Math.min(Math.max(parseInt(p.months, 10) || 12, 1), 24);
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCMonth(since.getUTCMonth() - (months - 1));
  const sinceUnix = Math.floor(since.getTime() / 1000);

  const warnings = [];

  // -- Subscriptions --------------------------------------------------------
  let subs = [];
  try {
    subs = await stripeList('/subscriptions', { status: 'all', 'expand[]': 'data.customer' });
  } catch (e) {
    console.error('[admin] subscriptions failed:', e.message);
    warnings.push(
      'Could not read subscriptions from Stripe (' + e.message + '). The restricted key needs Subscriptions: Read and Customers: Read.'
    );
  }

  // -- Charges, which cover memberships and one-off swag alike ---------------
  let charges = [];
  let haveCharges = true;
  try {
    charges = await stripeList('/charges', { 'created[gte]': sinceUnix });
  } catch (e) {
    haveCharges = false;
    console.error('[admin] charges failed:', e.message);
    warnings.push(
      'Revenue is blank because the Stripe key cannot read charges. Add Charges: Read to the restricted key. Nothing else is affected.'
    );
  }

  // -- Bookings -------------------------------------------------------------
  let bookings = [];
  try {
    bookings = await calAllBookings({ afterStart: since.toISOString(), limit: 100 }, 20);
  } catch (e) {
    console.error('[admin] cal bookings failed:', e.message);
    warnings.push('Usage is blank because Cal.com did not answer (' + e.message + ').');
  }

  // -- Members --------------------------------------------------------------
  const byEmail = {};
  function row(email) {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return null;
    if (!byEmail[key]) {
      byEmail[key] = {
        email: key, name: '', plan: '', amount: 0, interval: '', status: 'none',
        since: null, renews: null, comp: false, bookings: 0, hours: 0, lastBooking: null,
        noCard: false, subCount: 0, overdueDays: 0,
      };
    }
    return byEmail[key];
  }

  subs.forEach(function (sub) {
    const cust = sub.customer && typeof sub.customer === 'object' ? sub.customer : {};
    const r = row(cust.email);
    if (!r) return;
    // Two live subscriptions on one person means they are being charged twice.
    // Birrdi let that happen and nobody saw it, so count them here.
    if (ACTIVE.concat(AT_RISK).indexOf(sub.status) !== -1) r.subCount += 1;
    const plan = planLabel(sub);
    const better =
      ACTIVE.indexOf(sub.status) !== -1 ||
      (AT_RISK.indexOf(sub.status) !== -1 && ACTIVE.indexOf(r.status) === -1) ||
      r.status === 'none';
    if (better) {
      r.name = cust.name || r.name;
      r.plan = plan.label;
      r.amount = plan.amount;
      r.interval = plan.interval;
      r.status = sub.status;
      r.since = sub.start_date ? new Date(sub.start_date * 1000).toISOString() : null;
      r.renews = periodEnd(sub);
      r.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
      // No default card anywhere means the next renewal cannot charge. This is
      // how a membership goes quiet without anyone cancelling it.
      const settings = cust.invoice_settings || {};
      r.noCard = !sub.default_payment_method && !settings.default_payment_method;
    }
  });

  entryList(ENV.allowlist()).forEach(function (entry) {
    const r = row(entry.email);
    if (!r) return;
    r.comp = true;
    // Comped members have no Stripe customer, so without this the roster reads
    // "jrjb4165" instead of "Jace Bonham".
    if (entry.name) r.name = entry.name;
    if (ACTIVE.indexOf(r.status) === -1) {
      r.status = 'comp';
      r.plan = r.plan || 'Comped';
    }
  });

  // -- Usage ----------------------------------------------------------------
  const usageMonths = {};
  monthsBack(months).forEach((m) => { usageMonths[m] = { month: m, bookings: 0, hours: 0 }; });

  // Only bookings that have already started count as usage. A time booked for
  // next Tuesday is not an hour played, and counting it would inflate the
  // current month every time someone books ahead.
  bookings
    .filter((b) => b.status === 'accepted' && new Date(b.start).getTime() <= Date.now())
    .forEach(function (b) {
      const minutes = b.duration ||
        Math.max(0, Math.round((new Date(b.end) - new Date(b.start)) / 60000)) || 0;
      const hours = minutes / 60;
      const m = monthKey(b.start);
      if (usageMonths[m]) {
        usageMonths[m].bookings += 1;
        usageMonths[m].hours += hours;
      }
      const attendee = (b.attendees && b.attendees[0]) || {};
      const r = row(attendee.email);
      if (!r) return;
      if (!r.name && attendee.name) r.name = attendee.name;
      r.bookings += 1;
      r.hours += hours;
      if (!r.lastBooking || new Date(b.start) > new Date(r.lastBooking)) r.lastBooking = b.start;
    });

  // -- Revenue --------------------------------------------------------------
  const revenueMonths = {};
  monthsBack(months).forEach((m) => {
    revenueMonths[m] = { month: m, total: 0, membership: 0, other: 0, count: 0 };
  });

  charges
    .filter((c) => c.paid && c.status === 'succeeded')
    .forEach(function (c) {
      const net = (c.amount || 0) - (c.amount_refunded || 0);
      if (net <= 0) return;
      const m = monthKey(c.created);
      if (!revenueMonths[m]) return;
      revenueMonths[m].total += net;
      revenueMonths[m].count += 1;
      if (c.invoice) revenueMonths[m].membership += net;
      else revenueMonths[m].other += net;
    });

  // -- Roll up --------------------------------------------------------------
  const rows = Object.keys(byEmail)
    .map((k) => byEmail[k])
    .map(function (r) {
      r.hours = Math.round(r.hours * 10) / 10;
      if (!r.name) r.name = r.email.split('@')[0];
      // How long a failed membership has been failing. Isaak Grube sat seven
      // months past due in the old system before anyone noticed.
      if (AT_RISK.indexOf(r.status) !== -1 && r.renews) {
        const days = Math.floor((Date.now() - new Date(r.renews).getTime()) / 86400000);
        r.overdueDays = days > 0 ? days : 0;
      }
      return r;
    })
    .sort(function (a, b) {
      const rank = (s) => (ACTIVE.indexOf(s) !== -1 ? 0 : s === 'comp' ? 1 : AT_RISK.indexOf(s) !== -1 ? 2 : 3);
      return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
    });

  // Who has a password yet. Only worth asking for people who can log in at all.
  const canLogIn = rows.filter((r) => ACTIVE.indexOf(r.status) !== -1 || r.status === 'comp');
  try {
    const flags = await Promise.all(
      canLogIn.map((r) =>
        store.getAuth(event, r.email).then(
          (rec) => !!(rec && rec.hash),
          () => null
        )
      )
    );
    canLogIn.forEach((r, i) => { r.hasPassword = flags[i]; });
  } catch (e) {
    console.error('[admin] password flags failed:', e.message);
  }

  const paying = rows.filter((r) => ACTIVE.indexOf(r.status) !== -1);
  const atRisk = rows.filter((r) => AT_RISK.indexOf(r.status) !== -1);
  const comps = rows.filter((r) => r.status === 'comp');
  const former = rows.filter((r) => ['canceled', 'incomplete_expired'].indexOf(r.status) !== -1);

  const mrr = paying.reduce((sum, r) => sum + monthlyValue(r.amount, r.interval), 0);

  const QUIET_DAYS = 60;
  const quietCutoff = Date.now() - QUIET_DAYS * 24 * 60 * 60 * 1000;
  const quiet = paying
    .concat(comps)
    .filter((r) => !r.lastBooking || new Date(r.lastBooking).getTime() < quietCutoff)
    .map((r) => ({ name: r.name, email: r.email, lastBooking: r.lastBooking }));

  const top = rows
    .filter((r) => r.hours > 0)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 10)
    .map((r) => ({ name: r.name, email: r.email, bookings: r.bookings, hours: r.hours }));

  // Things that quietly cost money. Each one is a real case from the old
  // system: a subscription that stopped charging, a member with no card, and
  // one person billed on two plans at once.
  const problems = [];
  atRisk.forEach(function (r) {
    problems.push({
      kind: 'payment_failing',
      name: r.name,
      email: r.email,
      detail: r.status + (r.overdueDays ? ', ' + r.overdueDays + ' days past due' : ''),
      monthly: monthlyValue(r.amount, r.interval),
    });
  });
  paying.filter((r) => r.noCard).forEach(function (r) {
    problems.push({
      kind: 'no_card',
      name: r.name,
      email: r.email,
      detail: 'no card on file, next renewal will fail',
      monthly: monthlyValue(r.amount, r.interval),
    });
  });
  rows.filter((r) => r.subCount > 1).forEach(function (r) {
    problems.push({
      kind: 'double_billed',
      name: r.name,
      email: r.email,
      detail: r.subCount + ' live subscriptions on one person',
      monthly: monthlyValue(r.amount, r.interval),
    });
  });
  const atRiskMonthly = problems.reduce((sum, x) => sum + (x.monthly || 0), 0);

  const revenueList = monthsBack(months).map((m) => revenueMonths[m]);
  const usageList = monthsBack(months).map(function (m) {
    const u = usageMonths[m];
    u.hours = Math.round(u.hours * 10) / 10;
    return u;
  });

  return json(200, {
    generated: new Date().toISOString(),
    months: months,
    quietDays: QUIET_DAYS,
    haveRevenue: haveCharges,
    needPassword: canLogIn.filter((r) => r.hasPassword === false).map((r) => r.email),
    summary: {
      paying: paying.length,
      atRisk: atRisk.length,
      comped: comps.length,
      former: former.length,
      mrr: mrr,
      annualRunRate: mrr * 12,
      problems: problems.length,
      atRiskMonthly: atRiskMonthly,
    },
    problems: problems,
    revenue: revenueList,
    usage: usageList,
    topMembers: top,
    quiet: quiet,
    rows: rows,
    warnings: warnings,
  });
};
