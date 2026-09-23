# Deploying the cockpit — free, no card

A single container runs the API, the workers, the built UI and the SAP simulator.
Postgres is hosted separately. Total cost **$0/month**, and **no payment card** is
required at any step.

| Piece | Service | Card? | Free limit that matters |
|---|---|---|---|
| API + workers + UI + simulator | **Render**, free web service | No | sleeps after ~15 min idle; disk is ephemeral |
| Postgres | **Supabase**, free project | No | 500 MB; project pauses after ~7 days idle |
| Extraction | Google AI Studio key | No | free-tier capacity → intermittent `503`s |

## What this is, and what it isn't

It **is** a complete, publicly reachable demo: upload a PO PDF → the model reads it →
a human reviews the flagged fields → a separate approver signs it off → a CSV is
written to the drop folder → a Sales Order number comes back.

It **is not** the SAP integration. The drop folder lives on the container's own disk
and the bundled simulator plays S/4HANA. Real SAP needs a host that can see SAP's
actual file share, which means a machine inside your network. That's a different
deployment, and this one doesn't block it.

---

## Step 1 — put the code on GitHub

The project isn't a git repository yet.

```powershell
cd "E:\Innovun Global\MS_Cockpit_Simulation"
git init
git add -A
git status
```

**Before committing, confirm `backend/.env` is NOT in the list.** `.gitignore`
already excludes it, plus `storage/` and `integration/`. If you see it, stop and fix
`.gitignore` — that file holds your Gemini key and JWT secret.

```powershell
git commit -m "PO-to-SO automation cockpit"
```

Then create the remote. With the GitHub CLI:

```powershell
gh repo create po-cockpit --private --source=. --push
```

Without it: create an empty **private** repo on github.com, then

```powershell
git remote add origin https://github.com/<you>/po-cockpit.git
git branch -M main
git push -u origin main
```

## Step 2 — create the database

1. Sign up at **supabase.com** with GitHub. No card.
2. **New project**. Pick the region closest to you (Mumbai / Singapore for India).
3. Set a database password and **save it** — you need it in the next step.
4. Wait for provisioning (~2 min).

## Step 3 — get the right connection string ⚠️

**This is the one step that will silently waste your morning if you get it wrong.**

Supabase offers a *direct* connection and a *pooler* connection. The direct one is
**IPv6-only**, and Render's free tier makes **IPv4-only** outbound connections — so
the direct string fails from Render with a confusing DNS/timeout error.

In the project's **Connect** panel, take the **Session pooler** string (IPv4-compatible,
host looks like `...pooler.supabase.com`, port `5432`). Session mode supports prepared
statements, so Prisma works with no extra flags and no `directUrl` in the schema.

Avoid **Transaction pooler** (port `6543`) — it needs `?pgbouncer=true` plus a separate
`directUrl` for migrations, which is extra moving parts you don't need for one instance.

Substitute your saved password for `[YOUR-PASSWORD]`. Sanity-check it:

```powershell
$env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
npm -w backend exec prisma db execute --stdin
# paste:  SELECT 1;
# then Ctrl+Z, Enter   (Ctrl+D on mac/linux)
```

## Step 4 — migrate and seed, from your laptop

Migrations run from here, not on container boot — one less thing to fail during a
deploy. Shell variables take precedence over `backend/.env`, so your local setup is
untouched.

```powershell
$env:DATABASE_URL = "<the session pooler string from step 3>"

npm -w backend run prisma:deploy
npm -w backend run seed
```

**Check the output says `pooler.supabase.com`**, not `localhost:5439`. If it says
localhost, the variable didn't take — open a fresh terminal and set it again.

Expected: `1 migration applied` then `Seeded 4 users and 2 vendor profiles.`

## Step 5 — deploy on Render

1. Sign up at **render.com** with GitHub. No card for the free plan.
2. **New → Blueprint**, pick your repo. It reads `render.yaml` and creates the service.
3. It will ask for the two values marked `sync: false`:
   - `DATABASE_URL` → the session pooler string from step 3
   - `GEMINI_API_KEY` → your key (or leave blank and set `EXTRACTION_PROVIDER=mock`)
4. `JWT_SECRET` is generated for you. Don't set it by hand.
5. Deploy. The first build takes ~5–8 minutes (it installs dependencies and builds
   both the backend and the frontend inside the image).

If you'd rather not use the Blueprint: **New → Web Service**, connect the repo, choose
**Docker**, health check path `/api/health`, and copy the env vars out of `render.yaml`
by hand.

## Step 6 — verify

```powershell
curl https://<your-service>.onrender.com/api/health
```

You want `"ok":true` with all three checks passing:

```json
{"ok":true,"checks":{"database":{"ok":true},"outboundFolder":{"ok":true},"inboundFolder":{"ok":true}}}
```

- `database` false → wrong connection string (almost always the IPv6 direct one).
- `outboundFolder`/`inboundFolder` false → the container couldn't create its data dirs.

Then open the URL and sign in as `approver@cockpit.local` / `cockpit123`.

## Step 7 — pre-bake the demo data

**Do this the night before or an hour ahead — not live.**

Gemini's free tier returns `503 UNAVAILABLE` in bursts. It's per-model capacity, not
your key: during testing the same key got a 503 on `gemini-3.5-flash` and a 200 on
`3.6`, `3.7` and `3.8` in the same second. One PO needed 7 attempts.

So: upload two POs, publish them, and retry until they reach **Needs review**. Leave
them there. Your demo then walks real extracted data through review → approve → SAP →
SO number, and the only live steps are the ones that have never failed.

Generate test PDFs:

```powershell
npm -w backend exec tsx scripts/makeSamplePo.ts -- .\po1.pdf --vendor=northwind
npm -w backend exec tsx scripts/makeSamplePo.ts -- .\po2.pdf --vendor=mock
```

If capacity is against you, set `EXTRACTION_PROVIDER=mock` in Render and redeploy.
Mock is honest — the audit trail records `model: mock-extractor-v1` — and it produces
fields at 0.55–0.80 confidence, which is what makes the review screen's margin marks
visible. Real Gemini read the sample PO at 98–99%, so **nothing got flagged**, and the
flagging is the most interesting thing in the product.

---

## Demo-morning checklist

- [ ] Open the URL **10 minutes early** — free Render sleeps after 15 min idle and cold
      start takes ~40–60s. Don't let the audience watch that.
- [ ] `curl /api/health` → `ok:true`
- [ ] Both pre-baked records still in **Needs review**
- [ ] Signed in as `approver@cockpit.local` (the clerk **cannot** approve — that's the
      control you want to demonstrate, so know which account you're on)
- [ ] `SAP_SIM_FAILURE_RATE=0` if you don't want a random 15% rejection mid-demo.
      Set it back to `0.15` afterwards — the failure path is worth showing deliberately.

## Limits you must know

**The disk is ephemeral.** Render's free plan has no persistent volume, so on every
deploy and every wake-from-sleep the container starts with empty `storage/` and
`integration/`. Records and the audit trail survive in Supabase, but the **PDFs do
not** — the review screen's document pane will fail for records uploaded before a
restart. This is why step 7 says pre-bake *close* to the demo.

**Supabase pauses after ~7 days idle.** Open the dashboard once a week, or the first
request after a long gap fails while it wakes.

**The simulator fabricates Sales Order numbers.** `RUN_SAP_SIMULATOR=true` and
`SAP_SIM_ALLOW_IN_PRODUCTION=true` in `render.yaml` are what make the demo complete.
The simulator refuses to start under `NODE_ENV=production` without that second flag
precisely so this image can never invent orders against a real SAP landscape by
accident. **Never set those two on a deployment that talks to real SAP.**

**Free tier is 512 MB RAM** for two Node processes plus the Prisma engine. It fits, but
it's not roomy. If you see out-of-memory restarts, set `RUN_SAP_SIMULATOR=false` and
demo up to "Sent to SAP", or move to the alternative below.

## Rotate the Gemini key

The key currently in `backend/.env` was pasted into a chat transcript. Generate a fresh
one in Google AI Studio, put it in Render's env, and delete the old one. Never commit it
— `.gitignore` covers `backend/.env`, which is the only reason it isn't already public.

## If Render's free tier bites

**Hugging Face Spaces** (Docker SDK) is also free with no card, and for this app it's
arguably better: **16 GB RAM** instead of 512 MB, and it sleeps after ~48 hours idle
instead of 15 minutes. Same `Dockerfile`; you add an `app_port` to the Space's README
front-matter and set secrets in Space settings. Worth knowing as a fallback if memory
or cold starts get in the way.
