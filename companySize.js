// Public, cache-free "look up one company's size" API.
//
// Wraps the crawling/extraction logic already used by the scraper
// (companySizeCrawler.js) but returns the plain { company_size, source_url,
// status } contract, with no dependency on the DB cache - a single URL in,
// a single normalized answer out.

const { crawlSite, withTimeout, SITE_BUDGET_MS } = require("./companySizeCrawler")

function isValidHttpUrl(website) {
    if (!website || typeof website !== "string") return false
    try {
        const u = new URL(website)
        return u.protocol === "http:" || u.protocol === "https:"
    } catch {
        return false
    }
}

function formatNumber(n) {
    return Number(n).toLocaleString("en-US")
}

// "51-200" -> "51-200 employees", "10001+" -> "10,001+ employees"
function formatEmployeeRange(rangeStr) {
    if (!rangeStr) return null

    const open = rangeStr.match(/^(\d+)\+$/)
    if (open) return `${formatNumber(open[1])}+ employees`

    const range = rangeStr.match(/^(\d+)-(\d+)$/)
    if (range) return `${formatNumber(range[1])}-${formatNumber(range[2])} employees`

    return `${rangeStr} employees`
}

function toCompanySizeLabel(hit) {
    if (!hit) return null
    if (hit.employeeRange) return formatEmployeeRange(hit.employeeRange)
    if (hit.employeeCount) return `${formatNumber(hit.employeeCount)} employees`
    return null
}

const NOT_FOUND = Object.freeze({ company_size: null, source_url: null, status: "not_found" })

// browser (optional): a live puppeteer Browser instance to reuse for the
// JS-rendering fallback on pages whose static HTML is an empty SPA shell.
// Omit it and the lookup simply stays HTTP-only.
async function getCompanySize(website, browser) {
    if (!isValidHttpUrl(website)) return { ...NOT_FOUND }

    let hit
    try {
        hit = await withTimeout(crawlSite(website, browser), SITE_BUDGET_MS)
    } catch {
        return { ...NOT_FOUND }
    }

    const company_size = toCompanySizeLabel(hit)
    if (!company_size) return { ...NOT_FOUND }

    return { company_size, source_url: hit.sourceUrl, status: "found" }
}

module.exports = { getCompanySize }
