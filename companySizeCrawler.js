// Deterministic company-size crawler.
//
// Given a business's website, tries to figure out its employee count / employee
// range using only traditional scraping techniques: HTTP fetch + HTML parsing,
// JSON-LD structured data, regular expressions, and internal-link discovery.
// No LLM/AI API is used anywhere in this file.

// Node < 20 doesn't expose `File` as a global (it's only global from Node 20
// onward). cheerio depends on undici, which references the bare `File`
// identifier without feature-detecting it first - so on an older Node this
// throws "ReferenceError: File is not defined" the moment anything requires
// it (this can even be process tooling like PM2's module instrumentation,
// not just our own code). node:buffer has provided File since Node 18.13,
// below this project's stated minimum (18.17), so this polyfill is safe.
if (typeof globalThis.File === "undefined") {
    globalThis.File = require("node:buffer").File
}

const axios = require("axios")
const cheerio = require("cheerio")
const { URL } = require("url")
const { sql, eq } = require("drizzle-orm")
const db = require("./db")
const { companySizeCache } = require("./schema")

// ── Config ───────────────────────────────────────────────────────────────────

const CANDIDATE_PATHS = [
    "/", "/about", "/about-us", "/company", "/team", "/careers",
    "/jobs", "/contact", "/who-we-are", "/our-team"
]

// Used to spot same-site links worth following even when they live at a
// non-standard path (e.g. "/en/meet-the-team", "/company/leadership").
const LINK_KEYWORD_RE = /about|team|company|career|jobs?|who-we-are|our-team|staff|people|leadership/i

const MAX_PAGES_PER_SITE = 5
const REQUEST_TIMEOUT_MS = 4000
const PUPPETEER_TIMEOUT_MS = 6000
const PAGE_DELAY_MS = 150

// Hard ceiling on the whole crawl for one business's website, no matter how many
// pages/timeouts/fallbacks happen inside - a single slow or hanging site must
// never be able to stall the rest of the scrape.
const SITE_BUDGET_MS = 12000

const FOUND_TTL_MS = 60 * 24 * 60 * 60 * 1000   // 60 days - re-check occasionally
const UNKNOWN_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days - retry sooner, site may add info later

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

// Standard employee-range buckets (same convention LinkedIn/Crunchbase use),
// used only to normalize a single discovered number into a readable band.
const EMPLOYEE_BUCKETS = [
    [1, 10, "1-10"],
    [11, 50, "11-50"],
    [51, 200, "51-200"],
    [201, 500, "201-500"],
    [501, 1000, "501-1000"],
    [1001, 5000, "1001-5000"],
    [5001, 10000, "5001-10000"],
    [10001, Infinity, "10001+"],
]

function bucketFor(n) {
    if (!Number.isFinite(n) || n <= 0) return null
    const match = EMPLOYEE_BUCKETS.find(([lo, hi]) => n >= lo && n <= hi)
    return match ? match[2] : null
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms))
}

function withTimeout(promise, ms) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function normalizeDomain(website) {
    try {
        const u = new URL(website)
        return u.hostname.replace(/^www\./i, "").toLowerCase()
    } catch {
        return null
    }
}

// ── Extraction: regex over visible page text ────────────────────────────────

// "51-200 employees", "1,001 - 5,000 employees", "51 to 200 people"
const RANGE_RE = /\b([\d,]{1,6})\s*(?:-|–|—|to)\s*([\d,]{1,6})\+?\s*(?:employees|people|staff|team members)\b/i

// "500 employees", "over 10,000 employees", "team of 25", "25+ employees"
const COUNT_RE = /\b(?:over\s+|more than\s+)?([\d,]{2,7})\+?\s*(?:employees|team members|staff members|people)\b/i
const TEAM_OF_RE = /\bteam of\s+(?:over\s+)?([\d,]{1,6})\+?\b/i

function toInt(str) {
    if (!str) return null
    const n = parseInt(String(str).replace(/,/g, ""), 10)
    return Number.isFinite(n) ? n : null
}

function extractFromText(text) {
    if (!text) return null

    const rangeMatch = text.match(RANGE_RE)
    if (rangeMatch) {
        const lo = toInt(rangeMatch[1])
        const hi = toInt(rangeMatch[2])
        if (lo != null && hi != null && hi >= lo) {
            return { employeeCount: null, employeeRange: `${lo}-${hi}`, evidence: rangeMatch[0].trim() }
        }
    }

    const countMatch = text.match(COUNT_RE) || text.match(TEAM_OF_RE)
    if (countMatch) {
        const n = toInt(countMatch[1])
        if (n != null && n > 0) {
            return { employeeCount: n, employeeRange: bucketFor(n), evidence: countMatch[0].trim() }
        }
    }

    return null
}

// ── Extraction: JSON-LD structured data (schema.org Organization) ──────────

function extractFromJsonLd($) {
    const scripts = $('script[type="application/ld+json"]')

    for (let i = 0; i < scripts.length; i++) {
        let parsed
        try {
            parsed = JSON.parse($(scripts[i]).contents().text())
        } catch {
            continue
        }

        const roots = Array.isArray(parsed) ? parsed : [parsed]

        for (const root of roots) {
            const items = root && Array.isArray(root["@graph"]) ? root["@graph"] : [root]

            for (const item of items) {
                if (!item || typeof item !== "object") continue
                const noe = item.numberOfEmployees
                if (noe == null) continue

                if (typeof noe === "number" || typeof noe === "string") {
                    const n = toInt(noe)
                    if (n != null) return { employeeCount: n, employeeRange: bucketFor(n), evidence: `JSON-LD numberOfEmployees=${noe}` }
                }

                if (typeof noe === "object") {
                    const value = noe.value ?? noe["@value"]
                    const min = toInt(noe.minValue)
                    const max = toInt(noe.maxValue)
                    if (value != null) {
                        const n = toInt(value)
                        if (n != null) return { employeeCount: n, employeeRange: bucketFor(n), evidence: `JSON-LD numberOfEmployees.value=${value}` }
                    }
                    if (min != null && max != null) {
                        return { employeeCount: null, employeeRange: `${min}-${max}`, evidence: `JSON-LD numberOfEmployees range ${min}-${max}` }
                    }
                }
            }
        }
    }

    return null
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchStatic(url) {
    const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 5,
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        validateStatus: (status) => status >= 200 && status < 400,
    })
    return typeof res.data === "string" ? res.data : null
}

function bodyTextLength(html) {
    const $ = cheerio.load(html)
    $("script,style,noscript").remove()
    return $("body").text().replace(/\s+/g, " ").trim().length
}

// A page that renders almost no text server-side is very likely a JS SPA shell
// (React/Vue/Angular root div) - worth a headless-browser retry.
function looksLikeNeedsJs(html) {
    if (!html) return true
    try {
        return bodyTextLength(html) < 200
    } catch {
        return true
    }
}

async function fetchRendered(browser, url) {
    if (!browser) return null
    const page = await browser.newPage()
    try {
        await page.setUserAgent(USER_AGENT)
        page.setDefaultNavigationTimeout(PUPPETEER_TIMEOUT_MS)
        await page.goto(url, { waitUntil: "networkidle2", timeout: PUPPETEER_TIMEOUT_MS })
        return await page.content()
    } catch {
        return null
    } finally {
        await page.close().catch(() => {})
    }
}

async function fetchPage(url, browser) {
    let html = null
    try {
        html = await fetchStatic(url)
    } catch {
        html = null
    }

    if (looksLikeNeedsJs(html)) {
        const rendered = await fetchRendered(browser, url)
        if (rendered) html = rendered
    }

    return html
}

// ── Link discovery ───────────────────────────────────────────────────────────

function discoverCandidateLinks(html, origin) {
    const $ = cheerio.load(html)
    const found = new Set()
    const originHost = new URL(origin).hostname.replace(/^www\./i, "")

    $("a[href]").each((_, el) => {
        const href = $(el).attr("href")
        if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return

        let abs
        try {
            abs = new URL(href, origin)
        } catch {
            return
        }

        if (abs.hostname.replace(/^www\./i, "") !== originHost) return // stay on the same site

        const text = ($(el).text() || "").trim()
        if (LINK_KEYWORD_RE.test(abs.pathname) || LINK_KEYWORD_RE.test(text)) {
            abs.hash = ""
            found.add(abs.toString())
        }
    })

    return Array.from(found)
}

// ── Crawl orchestration ──────────────────────────────────────────────────────

function normalizeUrl(url) {
    return url.replace(/\/+$/, "").toLowerCase()
}

async function crawlSite(website, browser) {
    let originUrl
    try {
        originUrl = new URL(website)
    } catch {
        return null
    }
    const origin = `${originUrl.protocol}//${originUrl.host}`

    const visited = new Set()
    const queued = new Set()
    const toVisit = CANDIDATE_PATHS.map(p => origin + p)
    toVisit.forEach(u => queued.add(normalizeUrl(u)))

    let didLinkDiscovery = false

    for (let i = 0; i < toVisit.length && visited.size < MAX_PAGES_PER_SITE; i++) {
        const url = toVisit[i]
        const key = normalizeUrl(url)
        if (visited.has(key)) continue
        visited.add(key)

        const html = await fetchPage(url, browser)
        if (!html) {
            await delay(PAGE_DELAY_MS)
            continue
        }

        const $ = cheerio.load(html)

        const jsonLdHit = extractFromJsonLd($)
        if (jsonLdHit) return { ...jsonLdHit, sourceUrl: url }

        $("script,style,noscript").remove()
        const text = $("body").text().replace(/\s+/g, " ")
        const textHit = extractFromText(text)
        if (textHit) return { ...textHit, sourceUrl: url }

        // Only bother discovering extra links once, from whichever page loads first -
        // keeps the crawl bounded instead of exploding across the whole site.
        if (!didLinkDiscovery) {
            didLinkDiscovery = true
            const extraLinks = discoverCandidateLinks(html, origin)
            for (const link of extraLinks) {
                const linkKey = normalizeUrl(link)
                if (!queued.has(linkKey) && toVisit.length < MAX_PAGES_PER_SITE * 2) {
                    queued.add(linkKey)
                    toVisit.push(link)
                }
            }
        }

        await delay(PAGE_DELAY_MS)
    }

    return null
}

// ── Cache ────────────────────────────────────────────────────────────────────

async function getCachedResult(domain) {
    const rows = await db.select().from(companySizeCache).where(eq(companySizeCache.domain, domain)).limit(1)
    if (!rows.length) return null

    const row = rows[0]
    const ttl = row.status === "found" ? FOUND_TTL_MS : UNKNOWN_TTL_MS
    const age = Date.now() - new Date(row.checked_at).getTime()
    if (age > ttl) return null

    return {
        employeeCount: row.employee_count,
        employeeRange: row.employee_range,
        sizeSourceUrl: row.size_source_url,
        status: row.status,
    }
}

async function cacheResult(domain, result) {
    try {
        await db.insert(companySizeCache)
            .values({
                domain,
                employee_count: result.employeeCount,
                employee_range: result.employeeRange,
                size_source_url: result.sizeSourceUrl,
                status: result.status,
            })
            .onDuplicateKeyUpdate({
                set: {
                    employee_count: sql`VALUES(employee_count)`,
                    employee_range: sql`VALUES(employee_range)`,
                    size_source_url: sql`VALUES(size_source_url)`,
                    status: sql`VALUES(status)`,
                    checked_at: sql`CURRENT_TIMESTAMP`,
                }
            })
    } catch (err) {
        console.log(`  ⚠️ Could not cache company-size result for ${domain}: ${err.message}`)
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

const UNKNOWN_RESULT = Object.freeze({ employeeCount: null, employeeRange: null, sizeSourceUrl: null, status: "unknown" })

// browser (optional): a live puppeteer Browser instance to reuse for JS-rendering
// fallback. If omitted, JS-rendered sites simply won't get the puppeteer retry.
async function detectCompanySize(website, browser) {
    if (!website) return UNKNOWN_RESULT

    const domain = normalizeDomain(website)
    if (!domain) return UNKNOWN_RESULT

    const cached = await getCachedResult(domain)
    if (cached) return cached

    let result
    try {
        // Whatever is happening inside crawlSite (a slow site, a stuck fallback,
        // several timed-out candidate pages in a row), never let it exceed this
        // budget - the rest of the scrape run must not be able to stall on it.
        const hit = await withTimeout(crawlSite(website, browser), SITE_BUDGET_MS)
        result = hit
            ? { employeeCount: hit.employeeCount ?? null, employeeRange: hit.employeeRange ?? null, sizeSourceUrl: hit.sourceUrl, status: "found" }
            : { ...UNKNOWN_RESULT }
    } catch {
        result = { employeeCount: null, employeeRange: null, sizeSourceUrl: null, status: "error" }
    }

    await cacheResult(domain, result)
    return result
}

module.exports = {
    detectCompanySize,
    bucketFor,
    // Exported for reuse by companySize.js (the cache-free single-URL lookup)
    // and for unit testing - these are pure/network-only helpers with no DB coupling.
    crawlSite,
    withTimeout,
    normalizeDomain,
    extractFromText,
    extractFromJsonLd,
    SITE_BUDGET_MS,
}
