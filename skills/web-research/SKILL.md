---
name: web-research
description: Use when looking facts up on the web through web_search/fetch_content/source_check — 联网查资料、确认数字/录用率/版本/发布时间、找官方页面. Keeps a lookup to 1-3 calls with authoritative sources first instead of many wide searches.
---

# Web lookup with a budget

Every `web_search` round and every `fetch_content` page lands in the context and, with DeepSeek,
costs money per successful call. Spend calls on purpose.

## Pick the smallest first move

1. Ask what single page would settle it (official site, CFP, proceedings TOC, release notes,
   status page, HotCRP/registration system). If you can name it, `fetch_content` it directly.
2. Otherwise run **one** query: `web_search({query: ..., numResults: 3})`.
   - `numResults` defaults to 5. 3–4 is usually enough to find the authoritative link;
     raise it only when the first round is thin.
   - With DeepSeek each result carries a 600–1600 character `summary` (not a 100–200 character
     SERP snippet), so 3 results ≈ the payload of 8 results from a typical provider.
3. Add a query only if the first round is empty, off-topic, or contradicts itself.
   Never send 3 near-duplicate phrasings of the same question "to be safe" — that triples cost
   for the same page.

## Aim at sources that state the number

- Statistics usually live on: the venue's own page, HotCRP/CMT/HotCRP-style submission sites,
  proceedings front matter, `/releases`, changelogs, status pages.
- Search-engine hits about the same fact are often blog restatements with wrong or stale numbers
  (e.g. main-track acceptance rate quoted as the workshop's).
- If a fact is a count or a rate, prefer the page that prints the ratio (`N of M accepted`)
  over any page that requires you to count rows.

## Fetch cheaply

- Prefer one specific page over an index/aggregator; a 600 KB track page is worse than the
  5 KB page that answers the question.
- `fetch_content` returns a bounded slice (`maxInlineContentChars`, 30000 default). For an
  already-fetched page use `get_search_content({responseId, findText: [...]})` to pull just the
  passages you need — do not re-fetch the URL to look for a string.
- Do not re-download a page you already hold with `curl`; parse the stored copy.
- A `403` / "are you a bot" page will keep refusing. Switch source instead of retrying the same
  host with another client.

## Stop conditions

- You have the number/answer from a page that states it plainly → answer.
- Two rounds produced nothing usable → change angle (authoritative source, different phrasing,
  different language), not more results.
- Rows must be counted from a huge page → consider that a last resort and say so.

## Cheap-by-default checklist

- [ ] one query, `numResults: 3`
- [ ] authoritative page before blog restatement
- [ ] `findText` before a second fetch
- [ ] no near-duplicate queries in the same call
- [ ] no manual HTML scraping when a page states the figure
