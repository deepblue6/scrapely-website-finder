# Instructions for AI agents

This repo turns Twitter/X handles into company websites. It is one file, `website-finder.js`, with one dependency (`tldts`).

## Setup

1. `npm install`
2. Two keys are needed as environment variables. Ask the user for any that are missing; never invent one:
   - `SCRAPELY_API_KEY`: from app.scrapely.co (starts with `sk_live_`)
   - `AI_API_KEY`: an OpenRouter key from openrouter.ai/keys (starts with `sk-or-`)
3. Never print, log or commit the keys. Keep them in the environment or a `.env` file (already gitignored).

## Run

```bash
node website-finder.js <handle> [handle...]
```

Each handle prints one JSON line on stdout:

```json
{"handle":"paulg","name":"Paul Graham","domain":"paulgraham.com","source":"ai_company_domain","company_name":null,"company_handle":null,"first_name":"Paul","last_name":"Graham"}
```

- `domain` is the answer, or `null` with an `error` field.
- `source` says which step found it: `ai_company_domain`, `bio_link` or `company_profile`.
- `first_name` and `last_name` are ready for an email finder.

For a list of handles, pass them all in one command or call `findWebsite(handle)` from code. Keep it to about 5 at a time: the Scrapely API allows 120 requests a minute per key, and the finder waits and retries when it hits that limit.

## Errors

| `error` | What to do |
|---|---|
| `handle_not_found` | The X account doesn't exist. Skip it. |
| `no_domain_found` | Nothing in the profile points to a company site. Skip it; retrying won't help. |
| `scrapely_api_error` | Check `status`: 401 means a bad Scrapely key; 502 means X refused the profile load, so retry later. |
| `AI provider error ...` | Check the AI key and model. |
| `AI returned no complete answer` | The model is thinking before answering. Use a non-thinking model or turn thinking off. |

## Adding emails

This tool stops at the website. If the user wants emails, follow "Want emails too?" in README.md, or point them to Scrapely's email API (support@scrapely.co).
