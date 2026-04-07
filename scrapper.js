const puppeteer = require('puppeteer')
const db = require("./db")
const { leads } = require("./schema")
const { sql } = require('drizzle-orm')

function cleanPhone(phone) {
    if (!phone) return null
    return phone.replace(/\D/g, "")
}

async function saveLeads(data, keyword, city) {

    const uniqueMap = new Map()

    for (let lead of data) {
        const phone = cleanPhone(lead.phone)
        if (!phone || phone.length < 8) continue

        if (!uniqueMap.has(phone)) {
            uniqueMap.set(phone, {
                source: lead.source,
                name: lead.name,
                keyword,
                city,
                rating: lead.rating || null,
                phone,
                address: lead.address,
                website: lead.website,
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
                    address: sql`VALUES(address)`,
                    website: sql`VALUES(website)`,
                    keyword: sql`VALUES(keyword)`,
                    city: sql`VALUES(city)`
                }
            })
    }

    console.log(`✅ Saved ${uniqueLeads.length} leads`)
}

function chunkArray(arr, size) {
    return Array.from({ length: Math.ceil(arr.length / size) },
        (_, i) => arr.slice(i * size, i * size + size))
}


async function scrapeBusinesses(keyword, locations) {

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

            const data = await scrapeGoogleMaps(page, keyword, location)

            console.log(`  ✅ Got ${data.length} results from ${location}`)

            if (data.length > 0) {
                await saveLeads(data, keyword, location)
            } else {
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
}

async function autoScroll(page) {
    const scrollable = await page.$('div[role="feed"]')
    if (!scrollable) return

    for (let i = 0; i < 15; i++) {
        await page.evaluate(el => el.scrollBy(0, 3000), scrollable)
        await new Promise(r => setTimeout(r, 1000))
    }
}

async function scrapeGoogleMaps(page, keyword, location) {

    const query = `${keyword} in ${location}`

    await page.goto(
        `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 0 }
    )

    await page.waitForSelector('div[role="feed"]', { timeout: 15000 })

    await autoScroll(page)

    const links = await page.$$eval('.Nv2PK a[href*="/maps/place/"]', els =>
        els.map(el => el.href)
    )

    const uniqueLinks = [...new Set(links)]

    const results = []

    for (let i = 0; i < Math.min(uniqueLinks.length, 50); i++) {

        try {
            await page.goto(uniqueLinks[i], {
                waitUntil: "domcontentloaded",
                timeout: 30000
            })

            await page.waitForSelector("h1.DUwDvf", { timeout: 8000 }).catch(() => {})

            const data = await page.evaluate(() => {

                const name = document.querySelector("h1.DUwDvf")?.innerText || null
                const rating = document.querySelector(".MW4etd")?.innerText || null
                const phone = document.querySelector('[data-item-id^="phone"]')?.innerText || null
                const address = document.querySelector('[data-item-id="address"]')?.innerText || null
                const website = document.querySelector('[data-item-id="authority"]')?.href || null

                return { name, rating, phone, address, website }
            })

            if (data.name) {
                results.push({
                    source: "Google Maps",
                    ...data
                })
            }

            await new Promise(r => setTimeout(r, 500))

        } catch (err) {
            console.log(`  ⚠️ Skipped: ${err.message}`)
        }
    }

    return results
}

module.exports = scrapeBusinesses
