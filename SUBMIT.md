# Finishing this alone — the last two steps

Everything is built, pushed, hosted and verified. Two things remain, both done in
a browser, roughly ten minutes total.

This file is not part of the submission. Delete it before you submit if you like,
or leave it — it does no harm.

---

## Your links

| What | Where |
|---|---|
| The repo you submit | https://github.com/Adwaith673/prox-challenge |
| Live app | https://omnipro-220-specialist.onrender.com |
| Video | https://youtu.be/boKsWqR1Wis |
| Video file on this PC | `C:\Users\HP\Videos\prox-demo\omnipro-220-demo.mp4` |
| Render dashboard | https://dashboard.render.com |

---

## STEP 1 — Keep the site awake (~3 minutes)

### Why this matters

Render's free plan **puts the server to sleep after 15 minutes with no traffic**.
The next visitor's request wakes it, but that takes **30–60 seconds** during which
they stare at a blank loading page.

Prox review submissions days after you send them. If the first thing a reviewer
does is click your link and wait a minute, you have spent your best asset badly.
A hosted link that is slow to wake is worse than no hosted link, because it looks
broken rather than absent.

The fix is to have something visit the site every 10 minutes so it never idles
long enough to sleep. That is all a "keep-warm ping" is.

### Why it costs nothing

The URL being pinged is `/api/facts`. That endpoint reads the verified tables
that are committed in the repo and returns them as JSON. **It never calls the
Anthropic API**, so it costs no money, and it is a few kilobytes, so it costs no
meaningful bandwidth. Render's free plan gives 750 hours a month, which is about
31 days — enough for one service running continuously.

### Do it

1. Go to **https://console.cron-job.org/signup**
2. Sign up with your email. **No credit card** — it is a free community service
   with no paid tier for this.
3. Confirm the email they send you, then log in.
4. Click **CREATE CRONJOB** (big button, top right).
5. Fill in exactly:

   | Field | Value |
   |---|---|
   | **Title** | `keep omnipro awake` |
   | **URL** | `https://omnipro-220-specialist.onrender.com/api/facts` |
   | **Execution schedule** | choose **Every 10 minutes** |

   Leave everything else at its default. You do not need custom headers, a
   request body, or authentication.

6. Click **CREATE**.

### Check it worked

Wait about ten minutes, then open the job in cron-job.org and look at its
history. You want to see **200** against the recent runs.

One thing that is normal and not a problem: cron-job.org gives up on a request
after 30 seconds, so if the server happened to be asleep the very first ping may
show as a timeout or failure. **The request still woke the server.** The next
ping ten minutes later will come back 200. Only worry if it is still failing
after two or three attempts.

### A simpler alternative if you would rather not sign up

Just **open https://omnipro-220-specialist.onrender.com yourself** right before
you submit, and again the next morning. That keeps it warm for a while with no
account anywhere. It is worse than the pinger, because you cannot control when a
reviewer arrives — but it is better than nothing, and it takes no setup.

---

## STEP 2 — Submit (~5 minutes)

### Where the form actually is

The upstream README tells you to submit at **useprox.com/join/challenge**. That
page is **dead — it returns a 404.** Do not waste time on it.

The form moved onto the role page itself:

**https://useprox.com/join/founding-engineer**

Scroll to the bottom of that page. There is an application form there.

If for any reason that page has changed too, the other role pages carry the same
form and the same challenge:

- https://useprox.com/join/engineering-intern
- https://useprox.com/join

### What to put in it

| Field | What to enter |
|---|---|
| Name | Adwaith |
| Email | adwaithanand2007@gmail.com |
| Resume | your CV |
| **Link to your challenge fork** | `https://github.com/Adwaith673/prox-challenge` |
| Website (optional) | leave blank, or your portfolio |

**The fork URL is the important field.** Everything else — the live site, the
video, the write-up — is linked from the top of that repo's README, so they will
find all of it from that one link.

### Before you hit submit, sanity-check these three

Takes thirty seconds and prevents the embarrassing kind of mistake:

1. Open **https://github.com/Adwaith673/prox-challenge** in a private/incognito
   window. You should see the README with the video and live links at the top.
   If it says 404 in incognito, the repo is private and nobody can see it — fix
   that in Settings before submitting.
2. Click the **live link** from there. It should load the app.
3. Click the **video link**. It should play. (It is unlisted, which is correct —
   anyone with the link can watch. If it says "Video unavailable", it got set to
   Private by mistake.)

---

## If something breaks later

### The site is down or showing an error

Go to https://dashboard.render.com, click **omnipro-220-specialist**, then the
**Logs** tab. The two lines you want to see on a healthy boot are:

```
OmniPro 220 specialist  ->  http://...
auth: none — everything except the agent works; viewers supply their own key
```

That second line is correct and intentional. It means the server started without
an API key, which is exactly the design: the diagrams, widgets, manual browser
and rejection demo all work for anyone, and only asking the agent a question
needs a key, which the visitor supplies themselves.

To force a fresh deploy: **Manual Deploy** → **Deploy latest commit**.

### You changed the code and want it live

Render watches the `main` branch. Just push:

```bash
cd C:\Users\HP\prox-challenge
git add -A
git commit -m "your message"
git push
```

It redeploys automatically within a few minutes.

### Running it locally again

```bash
cd C:\Users\HP\prox-challenge
npm run web
```

Then open http://127.0.0.1:8788. Locally it uses your Claude CLI login, so you
will not be asked for a key.

Other commands worth knowing, none of which cost anything:

```bash
npm test               # 119 tests, offline, about a second
npm run verify:tables  # proves every table value traces to its cited manual page
npm run eval           # the full agent eval — this one DOES cost API money
```

---

## What to say if they reply

They review on a rolling basis and say they respond to every submission within a
few days. If you get a founder call, the three things worth leading with:

1. **The verifier.** `toSvg` only accepts a branded type that one function can
   mint, and that function recomputes both wiring sockets from the cited table
   row. A wrong-socket diagram is not unlikely — it is unrepresentable. Every
   other submission lets the model draw freehand.

2. **The corpus catch.** You built against a manual downloaded from Harbor
   Freight and it turned out to be a different revision from the one in `files/`
   — item 63621 versus 57812, 78 V open-circuit voltage versus 86, differing text
   on 29 of 48 pages. The CI gate caught it the moment the corpus was repointed;
   eight quotes stopped resolving. That is the argument for having the gate at
   all.

3. **The settings question.** They asked for a configurator that outputs wire
   speed and voltage. No such table exists in any of the four documents, because
   the machine is synergic and derives both itself. The first version refused the
   question outright, which was half right and completely unhelpful. It now gives
   the knob sequence from the manual and refuses only the two numbers the machine
   is responsible for.

Good luck.
