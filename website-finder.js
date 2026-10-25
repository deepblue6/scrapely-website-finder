#!/usr/bin/env node
// Twitter/X handle -> B2B company website (plus the person's name, ready for an email lookup).
// Same recipe Scrapely's email finder uses to pick a company domain, powered by
// the Scrapely profile API and your own AI key (OpenRouter by default, or any OpenAI-compatible provider).
//
//   SCRAPELY_API_KEY=sk_... AI_API_KEY=sk-or-... node website-finder.js elonmusk
//
// Want verified emails too? Scrapely's email API does it in one call: support@scrapely.co

import { getDomain } from "tldts";
import { pathToFileURL } from "node:url";

const SCRAPELY_API_URL = "https://app.scrapely.co/api/v1";
// DeepSeek V4 Flash: as accurate as GPT-4.1 mini in our tests, at about a seventh of the cost
const DEFAULT_AI_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_AI_MODEL = "deepseek/deepseek-v4-flash";
// @accounts in a bio loaded while the AI runs. Each one is a profile call against the rate limit.
const MAX_PREFETCH = 2;

// Domains that are never a company's website
const SKIP_DOMAINS = new Set([
  // Social / content platforms
  "medium.com", "linkedin.com", "substack.com", "instagram.com",
  "facebook.com", "twitter.com", "x.com", "github.com", "tiktok.com",
  "threads.net", "bsky.app", "youtube.com", "youtu.be", "twitch.tv",
  "behance.net", "dribbble.com", "reddit.com", "pinterest.com",
  // Link-in-bio / aggregators
  "linktr.ee", "lnk.bio", "bio.site", "bento.me", "beacons.ai",
  "stan.store", "carrd.co", "about.me", "intro.co",
  // Marketplaces / freelance
  "fiverr.com", "upwork.com",
  // Creator monetization
  "patreon.com", "gumroad.com", "ko-fi.com", "buymeacoffee.com",
  "beehiiv.com",
  // Messaging / community
  "discord.gg", "t.me", "wa.me",
  // Dev / hosting platforms
  "vercel.app", "netlify.app", "replit.app", "notion.so", "calendly.com", "cal.com",
  "softr.app", "mystrikingly.com",
  // URL shorteners
  "t.co", "bit.ly", "tinyurl.com", "shorturl.at", "goo.gl", "amzn.to",
  "ts.la", "msft.it", "lu.ma",
  // Other platforms
  "blog.google", "open.spotify.com", "docs.google.com",
]);

// Redirect targets that mean the domain is parked or for sale
const PARKED_DOMAINS = [
  "sedoparking.com", "bodis.com", "hugedomains.com", "afternic.com",
  "dan.com", "godaddy.com", "namecheap.com", "parkingcrew.net",
  "domainmarket.com", "undeveloped.com",
];

// Same prompt as Scrapely's email finder
const SYSTEM_PROMPT = `You are a data extraction assistant specialized in extracting structured contact information from Twitter/X profiles.

Your task: Given a Twitter profile, extract the person's real first name, last name, and their primary company information.

## Output Format
Respond with ONLY valid JSON matching this exact schema:
{"first_name": "...", "last_name": "...", "company_name": "...", "company_handle": "@...", "company_domain": "...", "email_in_bio": "..."}

## Rules for Name Extraction
- Extract the person's REAL first and last name (not a brand name, not a handle, not a nickname)
- The handle/username is NOT a real name. Do NOT split the handle into first/last name. Only use the display name and bio to find the real name.
- ONLY return first_name and last_name. Do NOT include middle names or initials.
- Examples: "Henry Ikoh" not "Henry I Koh", "John Smith" not "John A Smith", "Sarah Connor" not "Sarah Jane Connor"
- If you cannot determine a real first AND last name from the display name or bio, set last_name to null
- Job titles like "CEO", "Founder", "Co-Founder", "CTO", "Engineer", "Developer" are NOT names. Never return a job title as a name.
- If the display name is clearly a brand/company account (not a person), set both first_name and last_name to null

## Rules for Company Extraction
- Identify the primary company they founded, run, or currently work at
- If the company is referenced as @handle in the bio, return it as "@handle" in the company_handle field
- If you can identify a company domain from the website or bio URLs, return it in company_domain field
- Common patterns: "CEO of @company", "Founder @company", "Building @company", "Working at Company"

## Rules for Email Extraction
- If there is an email address visible in the bio text, return it in the email_in_bio field
- Only return actual email addresses, not domains or URLs

## General Rules
- If unsure about any field, return null for that field
- CRITICAL: Every value must be either a short string or null. NEVER write sentences or explanations as values.
- Do not explain your reasoning. Only output the JSON object.

## Examples
Input: Display name "Alex Hormozi", Bio "Co-Founder: acquisition.com, author of $100M Offers"
Output: {"first_name": "Alex", "last_name": "Hormozi", "company_name": "Acquisition.com", "company_handle": null, "company_domain": "acquisition.com", "email_in_bio": null}

Input: Display name "TechStartup", Bio "We build AI tools for developers"
Output: {"first_name": null, "last_name": null, "company_name": "TechStartup", "company_handle": null, "company_domain": null, "email_in_bio": null}

Input: Display name "Jason Calacanis", Bio "Host @theallinpod, angel investor, jason@calacanis.com"
Output: {"first_name": "Jason", "last_name": "Calacanis", "company_name": "The All-In Podcast", "company_handle": "@theallinpod", "company_domain": "calacanis.com", "email_in_bio": "jason@calacanis.com"}`;

// ─── Helpers ───────────────────────────────────────────────────────────────

// URL or bare domain -> root company domain (press.stripe.com -> stripe.com), or null if it's a skip domain.
// ownerHandle: a company account's handle. Its own domain is kept even if it's a skip domain (@Gumroad -> gumroad.com)
export function extractDomain(website, ownerHandle = null) {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    const hostname = url.hostname.replace(/^www\./, "");
    const rootDomain = getDomain(hostname);
    if (!rootDomain) return null;
    const isOwnDomain = !!ownerHandle && rootDomain.split(".")[0] === ownerHandle.toLowerCase();
    if (!isOwnDomain && (SKIP_DOMAINS.has(hostname) || SKIP_DOMAINS.has(rootDomain))) return null;
    return rootDomain;
  } catch {
    return null;
  }
}

// A company account's own site among its links: the one named like the account
// (@latecheckoutplz -> latecheckout.studio, not a partner's bfcm.stripe.com), else the first usable one
function pickOwnWebsite(links, handle, name) {
  const clean = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const owners = [clean(handle), clean(name)].filter((o) => o.length >= 3);
  const domains = links.map((link) => extractDomain(link, handle)).filter(Boolean);
  const own = domains.find((d) => {
    const label = clean(d.split(".")[0]);
    return label.length >= 3 && owners.some((o) => o.includes(label) || label.includes(o));
  });
  return own || domains[0] || null;
}

// Follow the domain's redirect (anevo.com -> anevomarketing.com), unless it lands somewhere useless
async function resolveDomainRedirect(domain) {
  try {
    const resp = await fetch(`https://${domain}`, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; scrapely-website-finder/1.0)" },
      signal: AbortSignal.timeout(5000),
    });
    const finalDomain = extractDomain(resp.url);
    if (!finalDomain || finalDomain === domain) return domain;
    if (PARKED_DOMAINS.some((p) => finalDomain.includes(p))) return domain;
    return finalDomain;
  } catch {
    // Timeout or dead domain: keep the original
    return domain;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchProfile(handle, scrapelyApiKey, attempt = 0) {
  const resp = await fetch(`${SCRAPELY_API_URL}/enrich/profile?handle=${encodeURIComponent(handle)}`, {
    headers: { "X-API-Key": scrapelyApiKey },
    signal: AbortSignal.timeout(30000),
  });
  // Rate limited (120 requests/minute per key): wait for the window to reset, then retry
  if (resp.status === 429 && attempt < 5) {
    const resetAt = Number(resp.headers.get("x-ratelimit-reset")) * 1000;
    await sleep(Math.min(Math.max(resetAt - Date.now(), 1000), 60000));
    return fetchProfile(handle, scrapelyApiKey, attempt + 1);
  }
  // X briefly refused the profile load: one more try usually works
  if (resp.status === 502 && attempt === 0) {
    await sleep(2000);
    return fetchProfile(handle, scrapelyApiKey, attempt + 1);
  }
  if (resp.status === 404) return { error: "handle_not_found" };
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    return { error: "scrapely_api_error", status: resp.status, message: body.message };
  }
  return { profile: await resp.json() };
}

async function extractProfile(profile, ai) {
  const userPrompt = `Profile:
- Display name: ${profile.name}
- Handle: @${profile.handle}
- Bio: ${profile.bio || "none"}
- Links found in bio: ${profile.bio_urls.join(", ") || "none"}`;

  const resp = await fetch(`${ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      // Thinking models (DeepSeek V4) otherwise spend the token budget reasoning and never answer
      ...(ai.baseUrl.includes("openrouter.ai") && { reasoning: { enabled: false } }),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  // Fail loudly rather than silently guessing from bio links (a thinking model can use up max_tokens)
  if (!content || data.choices[0].finish_reason === "length") {
    throw new Error(`AI returned no complete answer (finish_reason: ${data.choices?.[0]?.finish_reason}). If ${ai.model} is a thinking model, turn thinking off.`);
  }
  const parsed = JSON.parse(content);
  // Small models sometimes return "null" as a string, or ramble
  for (const key of Object.keys(parsed)) {
    if (["null", "none", "N/A"].includes(parsed[key])) parsed[key] = null;
    if (typeof parsed[key] === "string" && parsed[key].length > 40 && key !== "email_in_bio") parsed[key] = null;
  }
  // No real name found: fall back to the first word of the display name
  if (!parsed.first_name && profile.name) {
    const firstWord = profile.name.replace(/[^a-zA-Z\s-]/g, "").trim().split(/\s+/)[0];
    if (firstWord && firstWord.length >= 2) {
      parsed.first_name = firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
    }
  }
  return parsed;
}


// ─── Core ──────────────────────────────────────────────────────────────────

export async function findWebsite(handle, options = {}) {
  const scrapelyApiKey = options.scrapelyApiKey || process.env.SCRAPELY_API_KEY;
  const ai = {
    apiKey: options.aiApiKey || process.env.AI_API_KEY,
    baseUrl: (options.aiBaseUrl || process.env.AI_BASE_URL || DEFAULT_AI_BASE_URL).replace(/\/$/, ""),
    model: options.aiModel || process.env.AI_MODEL || DEFAULT_AI_MODEL,
  };
  if (!scrapelyApiKey) throw new Error("Missing SCRAPELY_API_KEY");
  if (!ai.apiKey) throw new Error("Missing AI_API_KEY");

  const cleanHandle = handle.replace(/^@/, "").trim();

  // 1. Profile from the Scrapely API (t.co links already resolved)
  const { profile, ...profileError } = await fetchProfile(cleanHandle, scrapelyApiKey);
  if (!profile) return { handle: cleanHandle, domain: null, ...profileError };

  const result = { handle: profile.handle, name: profile.name, domain: null, source: null, company_name: null, company_handle: null };

  // 2. Fast exit: no link, domain, or @mention anywhere means nothing to find (skips the AI call)
  const bio = profile.bio || "";
  const hasLinkDomain = profile.bio_urls.some((u) => extractDomain(u));
  const hasAtMention = /@[a-zA-Z0-9_]{2,}/.test(bio);
  const hasUrlInBio = /https?:\/\/[^\s]+/.test(bio);
  const hasDomainInBio = /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(bio.replace(/https?:\/\/[^\s]+/g, "").replace(/@\w+/g, ""));
  if (!hasLinkDomain && !hasAtMention && !hasUrlInBio && !hasDomainInBio) {
    return { ...result, error: "no_domain_found" };
  }

  // 3. AI reads the bio for their name, company name, company @handle, and domain.
  //    Meanwhile, start loading the @accounts the bio mentions, so the company account
  //    (step 5) is usually ready by the time the AI names it.
  const mentions = [...new Set((bio.match(/(?<![\w.])@\w{1,15}/g) || []).map((m) => m.slice(1).toLowerCase()))];
  const prefetched = new Map(
    mentions.slice(0, MAX_PREFETCH).map((h) => [h, fetchProfile(h, scrapelyApiKey).catch(() => ({}))])
  );
  const extracted = await extractProfile(profile, ai);
  result.first_name = extracted.first_name || null;
  result.last_name = extracted.last_name || null;
  result.company_name = extracted.company_name || null;

  // 4. Pick a domain: AI's company domain first, then the profile's own links
  let domain = extractDomain(extracted.company_domain);
  if (domain) result.source = "ai_company_domain";
  if (!domain) {
    domain = profile.bio_urls.map((u) => extractDomain(u)).find(Boolean) || null;
    if (domain) result.source = "bio_link";
  }

  // Start the redirect check (step 6) now, while step 5 runs
  const checkedDomain = domain;
  const redirectCheck = domain && resolveDomainRedirect(domain);

  // 5. Bio names a company account ("CEO @acme"): its domain beats a personal one
  if (extracted.company_handle) {
    const companyHandle = extracted.company_handle.replace(/^@/, "");
    result.company_handle = companyHandle;
    const { profile: company } = await (prefetched.get(companyHandle.toLowerCase())
      || fetchProfile(companyHandle, scrapelyApiKey).catch(() => ({})));
    if (company) {
      result.company_name = company.name || result.company_name;
      const bioEmail = (company.bio || "").match(/[\w.-]+@[\w.-]+\.\w+/);
      const companyDomain = (bioEmail && extractDomain(bioEmail[0].split("@")[1], companyHandle))
        || pickOwnWebsite(company.bio_urls, companyHandle, company.name);
      if (companyDomain && companyDomain !== domain) {
        domain = companyDomain;
        result.source = "company_profile";
      }
    }
  }

  if (!domain) return { ...result, error: "no_domain_found" };

  // 6. Follow redirects to the domain the company actually uses (already running unless step 5 switched domain)
  const redirected = await (domain === checkedDomain ? redirectCheck : resolveDomainRedirect(domain));
  if (redirected !== domain) result.redirected_from = domain;
  result.domain = redirected;
  return result;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--concurrency");
  const concurrency = flag === -1 ? 5 : Number(args.splice(flag, 2)[1]);
  const handles = args;
  if (handles.length === 0 || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error("Usage: node website-finder.js [--concurrency 5] <handle> [handle...]");
    process.exit(1);
  }

  // Look up `concurrency` handles at a time; each result prints as soon as it's done
  let next = 0;
  const worker = async () => {
    while (next < handles.length) {
      const handle = handles[next++];
      try {
        console.log(JSON.stringify(await findWebsite(handle)));
      } catch (e) {
        console.log(JSON.stringify({ handle, domain: null, error: e.message }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, handles.length) }, worker));
}
