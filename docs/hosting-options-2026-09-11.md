# Where to host the register — researched 2026-09-11

Five categories researched, each independently re-checked against live pricing and region
pages. The checks changed several answers, so what follows is the corrected version.

Vercel is excluded at the council's instruction.

---

## What actually constrains this

Worth restating, because it eliminates more options than price does.

**All 27 API route files are pinned to the Node runtime** — `node-postgres` and
`node:crypto`. Anything edge-only or Workers-only is out before price is discussed.

**Documents moved to Supabase Storage on 2026-09-11**, so the host no longer needs a
persistent filesystem. That was the constraint that used to rule out every ephemeral
platform, and it is gone.

**The database is on Supabase, ap-south-1 (Mumbai)** and is not moving. So the host runs
one small Next.js process for one user, idle almost all the time, talking to Supabase over
TLS.

**Procurement is the binding constraint, not money.** A council pays against a purchase
order, in rupees, with a GST invoice from an Indian entity. That is why Vercel went.

---

## The corrections that matter

The verification pass found four things worth more than the prices.

**Cloud Run does not support custom domain mappings in asia-south1.** Google's own docs
confirm it. The alternative Google recommends is a global external Application Load
Balancer at roughly $0.025/hour for the first five forwarding rules — about ₹1,700/month,
which is forty times the cost of the service it fronts. Either accept a `*.run.app`
address or the economics change completely. The original research never checked this and
it is the single most decisive finding.

**The exchange rate used throughout was stale.** ₹88/USD against an actual 95.57 on the
day. Every dollar-denominated figure was roughly 8% low.

**GeM — the Government e-Marketplace — was never mentioned by anyone.** It is the normal
purchasing channel for an Indian government or statutory body, and it is what actually
produces a purchase order. Whether a given provider is listed on GeM is a more practical
question than whether it "accepts POs".

**MeitY empanelment is a gate, not a nicety**, for this class of buyer. And NIC/MeghRaj
eligibility for a *state* statutory council was overstated in the research — it is not the
straightforward path it was presented as.

---

## The options, after checking

### Google Cloud Run, asia-south1 (Mumbai)

**~₹40/month** all in, and that is not a rounding error — it is genuinely near zero,
because the workload fits inside Cloud Run's free tier with orders of magnitude to spare.
The build plan's ₹6,570 model was mostly Cloud SQL, which Supabase has absorbed.

Mumbai is on Google's *cheaper* pricing tier. Cloud Scheduler is free at one job and
speaks `Asia/Kolkata` natively, with OIDC to a private service — so the daily job endpoint
need never be reachable from the open internet, which is better than the shared secret we
currently use. Zero maintainer burden: no OS, no kernel, no TLS renewal.

Invoicing is from **Google Cloud India Private Limited** — Indian entity, INR, 18% GST, a
proper tax invoice carrying the council's GSTIN. But invoiced billing, the mode you pay by
cheque or NEFT, requires an expected spend of **$40,000/year**. The council misses that by
four orders of magnitude and will be on a self-serve account. **UPI** is the escape from
the no-corporate-card problem — it works, in rupees, with no card — but requires
prepayment.

Costs: the `*.run.app` domain problem above, and a 2–5 second cold start on the first
click of the morning.

### DigitalOcean App Platform, BLR1 (Bangalore)

**~₹1,425/month.** Survived verification and came out *stronger* than first argued. An
Indian region, a managed platform — git push and it deploys — custom domain with free
managed TLS, and one-click rollback. DigitalOcean charges Indian GST and issues an Indian
invoice; those tax claims were verified verbatim.

The nearest thing to "live this week with a real domain and nothing to administer".

### Azure App Service (Linux, B1), Central India

**₹1,481/month including GST**, bought **through an Indian CSP partner** — which is the
one arrangement that genuinely produces INR + GST from an Indian entity *against a purchase
order*. If procurement is the hard constraint rather than a preference, this is the option
built for it. The verification pass changed the pick here from Container Apps to App
Service on price grounds.

### E2E Networks, Delhi-NCR or Mumbai

The Indian-sovereignty answer. NSE-listed Indian company, **MeitY-empanelled**, which in a
procurement note is a sentence rather than an argument. Roughly **₹2,800–4,000/month** at
corrected rates.

It is a **virtual machine**, which means the officer — or somebody they hire — owns the
operating system, the TLS certificate, the firewall and the backups. That is the real
price, and it is not paid in rupees.

### AWS Lightsail, Mumbai — $12 bundle

**~₹1,345/month** for 2 vCPU / 2 GB / 60 GB. Best of the plain-VM options, and AWS India
invoices in INR with GST. Same caveat as E2E: you are the system administrator.

### Ruled out

**Railway and Koyeb have no Indian region.** Render's nearest is Singapore. Fly.io has
Mumbai (`bom`) but its billing and operational story is weaker than the alternatives at
this size. Deno Deploy Classic shut down in July 2026.

---

## Recommendation

**Start on DigitalOcean App Platform in Bangalore.** It gets the register live this week
with a real domain, free TLS, managed TLS renewal, one-click rollback and an Indian region
— and nothing for a dental officer to administer. At ~₹1,425/month it is not the cheapest,
and that is the right trade while the priority is *being used at all*.

**Revisit at the point the council formally adopts the system.** That is when procurement
becomes real, and at that point the two serious candidates are Azure App Service through an
Indian CSP partner (because it produces a purchase order) or Cloud Run (because it costs
₹40 and has the best Indian billing entity, if a `run.app` address is acceptable or a load
balancer is affordable by then).

The application is a standalone container behind one environment file. Moving it later is
an afternoon, not a migration — which is exactly why starting on the simplest thing is
defensible rather than lazy.

**Do not choose a bare VM** — not E2E, not Lightsail — unless there is a named person
other than the officer who will patch it. The rupee saving is real; the 11pm phone call is
also real, and there is currently nobody to make it to.

---

## What to settle before deploying

1. **A domain.** Something under `ksdc.in`, or a vendor subdomain for now. This decides
   whether Cloud Run is viable at ₹40 or ₹1,700.
2. **An SMTP provider.** `MAIL_TRANSPORT=console` today — the digest goes to a log file.
   Supabase's built-in sender is fine for sign-in codes and poor for anything a dentist
   receives.
3. **`SCHEDULER_SECRET`**, and something to call the daily job. GitHub Actions cron is free
   and decouples this from the hosting choice entirely.
4. **Whether the council will hold the billing relationship**, or whether this stays on a
   personal card for now. The code gates real case data on the former.
