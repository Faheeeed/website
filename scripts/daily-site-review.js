// scripts/daily-site-review.js
//
// Fetches the live faheed.com pages, sends them to Claude for a design/content/link
// review, and files the result as a GitHub Issue for approval.
//
// Requires two repo secrets:
//   ANTHROPIC_API_KEY  - your Anthropic API key
//   GITHUB_TOKEN       - provided automatically by GitHub Actions, no setup needed

const BASE_URL = "https://faheed.com";

// Add/remove pages here as the site grows.
const PAGES = [
  "",
  "testimonials.html",
  "pricing.html",
  "contact.html",
  "instagram.html",
  "ai-policy.html",
  "pickleball.html",
];

const REVIEW_INSTRUCTIONS = `
You are reviewing the live website for Faheed's Strength & Conditioning, an
NSCA-certified strength and conditioning business in Alexandria, VA. You will
be given the raw HTML of several pages.

Design system to check against:
- Fonts: Cormorant Garamond (serif) + Jost (sans-serif)
- CSS custom properties: --cream, --parchment, --warm-mid, --stone, --bark,
  --soil, --ink, --sage, --gold-thin
- Dark, earthy, typographically refined, compact aesthetic. Minimal
  whitespace, no unnecessary ornamentation.

Check for:
1. Broken or suspicious links (internal nav, external links, booking/contact links)
2. Design consistency - pages that visually drift from the palette/fonts above
3. Placeholder or stale content ("TBD", outdated copyright year, etc.)
4. Layout problems (obvious HTML/CSS issues, not just guesses about rendering)
5. Typos or grammar issues in visible copy
6. SEO basics - missing/weak meta description, missing alt text, unclear <title>
7. CTA clarity - is booking/contact obvious on each page

Do NOT flag:
- The in-season programming teaser card (intentionally gated/mysterious by design)
- The testimonials page being in a placeholder/"TBD" state (known, in progress)
- Anything suggesting AI be used for programming, fitness testing, or program
  design (the site has a firm policy that this is always human-delivered)

Output format: a short numbered list. Each item: page name, the issue, and a
one-line proposed fix. Be concise - only flag things that are genuinely broken
or inconsistent, not subjective style nitpicks. If a page is totally fine,
don't manufacture an issue for it. If nothing across the whole site needs
attention, just say so plainly.
`.trim();

async function fetchPage(path) {
  const url = path ? `${BASE_URL}/${path}` : `${BASE_URL}/`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { url, ok: false, status: res.status, html: null };
    }
    let html = await res.text();
    // Strip script/style contents to save tokens - we care about markup/copy, not JS/CSS logic.
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/\n\s*\n/g, "\n")
      .trim();
    // Cap length defensively so one huge page can't blow up the prompt.
    if (html.length > 20000) html = html.slice(0, 20000) + "\n<!-- truncated -->";
    return { url, ok: true, status: res.status, html };
  } catch (err) {
    return { url, ok: false, status: "fetch_error", html: null, error: String(err) };
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const ghToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"

  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY secret");
  if (!ghToken) throw new Error("Missing GITHUB_TOKEN");
  if (!repo) throw new Error("Missing GITHUB_REPOSITORY");

  console.log("Fetching pages...");
  const pages = await Promise.all(PAGES.map(fetchPage));

  let pageBlock = "";
  for (const p of pages) {
    if (p.ok) {
      pageBlock += `\n\n=== PAGE: ${p.url} ===\n${p.html}`;
    } else {
      pageBlock += `\n\n=== PAGE: ${p.url} ===\n[FAILED TO FETCH - status: ${p.status}${p.error ? ", error: " + p.error : ""}]`;
    }
  }

  const userPrompt = `${REVIEW_INSTRUCTIONS}\n\nHere are the pages:${pageBlock}`;

  console.log("Calling Claude...");
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    throw new Error(`Claude API error ${claudeRes.status}: ${errText}`);
  }

  const claudeData = await claudeRes.json();
  const reviewText = claudeData.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const today = new Date().toISOString().slice(0, 10);
  const failedFetches = pages.filter((p) => !p.ok);
  let noteBlock = "";
  if (failedFetches.length > 0) {
    noteBlock =
      "\n\n---\n**Note:** these pages failed to fetch and were not reviewed:\n" +
      failedFetches.map((p) => `- ${p.url} (${p.status})`).join("\n");
  }

  const issueBody = `${reviewText}${noteBlock}\n\n---\n_Automated daily review. Comment with what to fix, or close this issue to dismiss it._`;

  console.log("Filing GitHub issue...");
  const issueRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `Site Review — ${today}`,
      body: issueBody,
      labels: ["site-review"],
    }),
  });

  if (!issueRes.ok) {
    const errText = await issueRes.text();
    throw new Error(`GitHub API error ${issueRes.status}: ${errText}`);
  }

  const issue = await issueRes.json();
  console.log(`Filed issue: ${issue.html_url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
