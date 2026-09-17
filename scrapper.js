const puppeteer = require('puppeteer')
const db = require("./db")
const { leads } = require("./schema")
const { sql, eq } = require('drizzle-orm')
const countries = require("i18n-iso-countries")
const { detectCompanySize } = require("./companySizeCrawler")
countries.registerLocale(require("i18n-iso-countries/langs/en.json"))

// ── Background employee-size enrichment ─────────────────────────────────────
//
// Company-size detection crawls the business's own website (up to a few
// pages, several seconds each in the worst case). It must never block the
// main Maps scraping loop - a single slow/unreachable site used to stall
// every business behind it and the whole location's save with it. Instead,
// leads are saved immediately with employee_count/range null, and a bounded
// pool of background lookups patches those columns in as they resolve.
const SIZE_LOOKUP_CONCURRENCY = 5

let activeSizeLookups = 0
const sizeLookupQueue = []
const pendingSizeLookups = []

function runQueuedSizeLookups() {
    while (activeSizeLookups < SIZE_LOOKUP_CONCURRENCY && sizeLookupQueue.length > 0) {
        const task = sizeLookupQueue.shift()
        activeSizeLookups++
        const done = task().finally(() => {
            activeSizeLookups--
            runQueuedSizeLookups()
        })
        pendingSizeLookups.push(done)
    }
}

function queueEmployeeSizeLookup(website, phone) {
    sizeLookupQueue.push(async () => {
        try {
            // No puppeteer browser passed - this is HTTP-only (axios/cheerio).
            // Employee size is informational only, so we trade the JS-render
            // fallback's accuracy on SPA sites for speed here.
            const sizeInfo = await detectCompanySize(website)
            if (sizeInfo.employeeCount == null && sizeInfo.employeeRange == null) return

            await db.update(leads)
                .set({
                    employee_count: sizeInfo.employeeCount,
                    employee_range: sizeInfo.employeeRange,
                    size_source_url: sizeInfo.sizeSourceUrl,
                })
                .where(eq(leads.phone, phone))
        } catch (err) {
            console.log(`  ⚠️ Employee-size lookup failed for ${website}: ${err.message}`)
        }
    })
    runQueuedSizeLookups()
}

// New lookups can be queued by earlier ones finishing while we're draining
// (runQueuedSizeLookups keeps pulling off sizeLookupQueue), so this drains in
// rounds until both the in-flight and queued work are gone.
async function waitForPendingSizeLookups() {
    while (pendingSizeLookups.length > 0 || sizeLookupQueue.length > 0) {
        const batch = pendingSizeLookups.splice(0, pendingSizeLookups.length)
        await Promise.allSettled(batch)
    }
}

function cleanPhone(phone) {
    if (!phone) return null
    return phone.replace(/\D/g, "")
}

function parseRating(text) {
    if (!text) return null
    const match = text.match(/[\d.]+/)
    if (!match) return null
    const value = parseFloat(match[0])
    return Number.isNaN(value) ? null : value
}

function parseReviewCount(text) {
    if (!text) return null
    const digits = text.replace(/[^\d]/g, "")
    if (!digits) return null
    const value = parseInt(digits, 10)
    return Number.isNaN(value) ? null : value
}

function passesFilters(rating, reviewsCount, filters) {
    if (!filters) return true
    if (filters.minRating != null && (rating == null || rating < filters.minRating)) return false
    if (filters.maxRating != null && (rating == null || rating > filters.maxRating)) return false
    if (filters.minReviews != null && (reviewsCount == null || reviewsCount < filters.minReviews)) return false
    if (filters.maxReviews != null && (reviewsCount == null || reviewsCount > filters.maxReviews)) return false
    return true
}

function extractCountryInfo(phone, address) {
    let dial_code = null
    let country_code = null

    if (phone) {
        const match = phone.match(/\+\d{1,3}/)
        if (match) {
            dial_code = match[0]
        }
    }

    if (address) {
        const parts = address.split(",").map(p => p.trim())
        const lastPart = parts[parts.length - 1]

        if (lastPart) {
            const code = countries.getAlpha2Code(lastPart, "en")
            if (code) {
                country_code = code
            }
        }
    }

    return { country_code, dial_code }
}

async function saveLeads(data, keyword, city, keywordId) {

    const uniqueMap = new Map()

    for (let lead of data) {
        const rawPhone = lead.phone
        const phone = cleanPhone(lead.phone)
        if (!phone || phone.length < 10) continue

        if (!uniqueMap.has(phone)) {
            uniqueMap.set(phone, {
                source: lead.source,
                name: lead.name,
                keyword,
                keyword_id: keywordId,
                city,
                rating: lead.rating || null,
                reviews_count: lead.reviews_count ?? null,
                phone,
                address: lead.address,
                website: lead.website,
                country_code: lead.country_code,
                dial_code: lead.dial_code,
                employee_count: lead.employee_count ?? null,
                employee_range: lead.employee_range ?? null,
                size_source_url: lead.size_source_url ?? null,
            })
        }
    }

    const uniqueLeads = Array.from(uniqueMap.values())

    const chunkSize = 100

    for (let i = 0; i < uniqueLeads.length; i += chunkSize) {
        const chunk = uniqueLeads.slice(i, i + chunkSize)

        await db.insert(leads)
            .values(chunk)
            .onDuplicateKeyUpdate({
                set: {
                    name: sql`VALUES(name)`,
                    rating: sql`VALUES(rating)`,
                    reviews_count: sql`VALUES(reviews_count)`,
                    address: sql`VALUES(address)`,
                    website: sql`VALUES(website)`,
                    keyword: sql`VALUES(keyword)`,
                    city: sql`VALUES(city)`,
                    keyword_id: sql`IFNULL(${leads.keyword_id}, VALUES(keyword_id))`,
                    country_code: sql`VALUES(country_code)`,
                    dial_code: sql`VALUES(dial_code)`,
                    employee_count: sql`VALUES(employee_count)`,
                    employee_range: sql`VALUES(employee_range)`,
                    size_source_url: sql`VALUES(size_source_url)`,
                }
            })
    }

    console.log(`✅ Saved ${uniqueLeads.length} leads`)
}

async function scrapeBusinesses(keyword, locations, keywordId, filters = {}) {

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled"
        ]
    })

    const page = await browser.newPage()

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
            get: () => false
        })
    })

    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    )

    page.setDefaultTimeout(60000)

    try {

        for (let location of locations) {

            console.log(`🔍 Scraping "${keyword}" in "${location}"`)

            // Leads are now saved as each business is found (see scrapeGoogleMaps),
            // so `data` here is just for the summary log below.
            const data = await scrapeGoogleMaps(page, keyword, location, keywordId, filters)

            console.log(`  ✅ Got ${data.length} results from ${location}`)

            if (data.length === 0) {
                console.log(`  ⚠️ No data found for ${location}`)
            }

            await new Promise(r => setTimeout(r, 2000))
        }

    } catch (error) {
        console.error("❌ Scraping error:", error.message)
    } finally {
        await browser.close()
        console.log("🛑 Browser closed")
    }

    // The browser is already closed - these are plain HTTP lookups against
    // business websites, not Maps navigation, so they can keep running
    // without holding the (now-freed) browser open.
    await waitForPendingSizeLookups()
    console.log("✅ Employee-size lookups complete")
}

async function autoScroll(page) {
    const scrollable = await page.$('div[role="feed"]')
    if (!scrollable) return

    for (let i = 0; i < 15; i++) {
        await page.evaluate(el => el.scrollBy(0, 3000), scrollable)
        await new Promise(r => setTimeout(r, 1000))
    }
}

async function scrapeGoogleMaps(page, keyword, location, keywordId, filters = {}) {

    const query = `${keyword} in ${location}`

    await page.goto(
        `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 0 }
    )

    await page.waitForSelector('div[role="feed"]', { timeout: 15000 })

    await autoScroll(page)

    // Grab rating/review data straight from the results feed cards so businesses
    // that don't meet the filters can be skipped before we ever visit their page.
    const cards = await page.$$eval('.Nv2PK', els =>
        els.map(el => ({
            link: el.querySelector('a[href*="/maps/place/"]')?.href || null,
            ratingText: el.querySelector(".MW4etd")?.innerText || null,
            reviewsText: el.querySelector(".UY7F9")?.innerText || null
        }))
    )

    const seenLinks = new Set()
    const candidates = []
    for (const card of cards) {
        if (!card.link || seenLinks.has(card.link)) continue
        seenLinks.add(card.link)

        const feedRating = parseRating(card.ratingText)
        const feedReviews = parseReviewCount(card.reviewsText)

        if (!passesFilters(feedRating, feedReviews, filters)) continue

        candidates.push({ link: card.link, feedRating, feedReviews })
    }

    const results = []

    for (let i = 0; i < Math.min(candidates.length, 50); i++) {
        const { link, feedRating, feedReviews } = candidates[i]

        try {
            await page.goto(link, {
                waitUntil: "domcontentloaded",
                timeout: 30000
            })

            await page.waitForSelector("h1.DUwDvf", { timeout: 8000 }).catch(() => { })

            const data = await page.evaluate(() => {

                const name = document.querySelector("h1.DUwDvf")?.innerText || null
                const rating = document.querySelector(".MW4etd")?.innerText || null
                const reviewsText = document.querySelector(".UY7F9")?.innerText || null
                const phone = document.querySelector('[data-item-id^="phone"]')?.innerText || null
                const address = document.querySelector('[data-item-id="address"]')?.innerText || null
                const website = document.querySelector('[data-item-id="authority"]')?.href || null

                return { name, rating, reviewsText, phone, address, website }
            })

            // Prefer the authoritative value scraped from the business page itself,
            // falling back to the feed-card value if the page didn't expose it.
            const rating = parseRating(data.rating) ?? feedRating
            const reviewsCount = parseReviewCount(data.reviewsText) ?? feedReviews

            if (data.name && passesFilters(rating, reviewsCount, filters)) {
                const phone = cleanPhone(data.phone)

                if (phone && phone.length >= 10) {
                    const { country_code, dial_code } = extractCountryInfo(data.phone, data.address)

                    const lead = {
                        source: "Google Maps",
                        name: data.name,
                        rating,
                        reviews_count: reviewsCount,
                        phone,
                        address: data.address,
                        website: data.website,
                        country_code,
                        dial_code,
                        employee_count: null,
                        employee_range: null,
                        size_source_url: null,
                    }

                    results.push(lead)

                    // Save immediately - don't wait for the whole location's
                    // candidate list (up to 50 businesses) to finish before any
                    // data reaches the DB.
                    await saveLeads([lead], keyword, location, keywordId)

                    // Company-size crawling hits an external site and can be slow
                    // or hang on a bad site. It's informational only - never let
                    // it block scraping the next business. Runs in the background
                    // and patches this row's employee_* columns once resolved.
                    if (data.website) {
                        queueEmployeeSizeLookup(data.website, phone)
                    }
                }
            }

            await new Promise(r => setTimeout(r, 500))

        } catch (err) {
            console.log(`  ⚠️ Skipped: ${err.message}`)
        }
    }

    return results
}

module.exports = scrapeBusinesses
