# scrapely-website-finder

Turn a Twitter/X handle into the company website behind it, plus the person's first and last name.

```bash
npm install
export SCRAPELY_API_KEY=sk_...   # from app.scrapely.co
export AI_API_KEY=sk-or-...      # your OpenRouter key (openrouter.ai/keys)
node website-finder.js levelsio paulg
```

```json
{"handle":"janedoe","name":"Jane Doe","domain":"acme.com","source":"company_profile","company_name":"Acme","company_handle":"acme","first_name":"Jane","last_name":"Doe"}
```

## Use it with your AI agent

Paste this into Claude Code, Cursor, Codex or any coding agent:

> Clone https://github.com/deepblue6/scrapely-website-finder, run npm install, and follow AGENTS.md to find the company website for these Twitter/X handles: @paulg, @levelsio. Ask me for my Scrapely and OpenRouter API keys.

The agent instructions live in [AGENTS.md](AGENTS.md) (also linked as CLAUDE.md for Claude Code).

## Want emails too?

This tool stops at the website, but you now have everything an email finder needs: `first_name`, `last_name` and `domain`. Two ways to get the email:

**Build it yourself.** Plug those three fields into an email finder or verifier like [LeadMagic](https://leadmagic.io) or [MailTester Ninja](https://mailtester.ninja). Or paste this into your coding agent (Claude Code, Cursor, etc.):

> Add an email step to website-finder.js. After the domain is found, if LEADMAGIC_API_KEY is set: with a first and last name, call LeadMagic's Email Finder (POST https://api.leadmagic.io/v1/people/email-finder with first_name, last_name, domain) and keep the email if status is valid or catch-all. Otherwise, or if it misses, validate a first@domain guess with POST /v1/people/email-validation and keep it only if email_status is valid. Add `email` and `email_validity` to the result.

**Or skip the build.** Scrapely's email API does it in one call, with verified emails only. Email [support@scrapely.co](mailto:support@scrapely.co).

## Use it in code

```js
import { findWebsite } from "./website-finder.js";
const { domain, first_name, last_name } = await findWebsite("paulg", { scrapelyApiKey, aiApiKey });
```

## How it works

This is the same method Scrapely's email finder uses to pick a company domain:

1. Pull the profile (name, bio, links in bio) from the [Scrapely profile API](https://app.scrapely.co).
2. Skip the AI entirely if the bio has no link, domain or @mention.
3. Ask the AI for the company name, company @handle, and company domain.
4. Use the AI's domain, otherwise the first link in the bio that's a real company site. Social, link-in-bio, and shortener domains are ignored.
5. If the bio names a company account ("CEO @acme"), look that profile up too and prefer its domain.
6. Follow the domain's redirects to the one the company actually uses, but never onto parked or for-sale pages.

`source` tells you which step found the domain: `ai_company_domain`, `bio_link`, or `company_profile`.

## Speed and cost

In our tests: about 3 seconds per profile and about $0.05 of AI per 1,000 profiles. The Scrapely profile API is free.

It looks up 5 handles at a time by default. Change that with `--concurrency`:

```bash
node website-finder.js --concurrency 10 $(cat handles.txt)
```

Results print as each one finishes, so they may come out in a different order than you gave them. Each line includes `handle`. Your Scrapely key allows 120 requests a minute (each profile uses 1 to 3), which works out to about 1,000 profiles in 20 minutes. If you go past the limit, the finder waits and retries for you. Need a higher limit? Email [support@scrapely.co](mailto:support@scrapely.co).

## Other AI models

The default is DeepSeek V4 Flash on OpenRouter, with thinking turned off so it answers straight away. Any other model works too:

```bash
AI_MODEL=openai/gpt-4.1-mini node website-finder.js paulg                     # another OpenRouter model
AI_BASE_URL=https://api.openai.com/v1 AI_MODEL=gpt-4.1-mini node website-finder.js paulg   # OpenAI directly
```

Any OpenAI-compatible API works (Groq, Together, a local model). If you pick a thinking model outside OpenRouter, turn its thinking off, or it can run out of room before it answers.

## Errors

| `error` | Meaning |
|---|---|
| `handle_not_found` | No X profile for that handle |
| `no_domain_found` | Nothing in the profile points to a company site |
| `scrapely_api_error` | The Scrapely API rejected the call (check `status` and `message`) |
