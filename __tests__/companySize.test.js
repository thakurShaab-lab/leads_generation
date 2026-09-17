// Avoid opening a real MySQL pool: companySizeCrawler.js requires ./db at
// module scope purely for its DB-cache helpers, none of which getCompanySize
// (the function under test) ever calls.
jest.mock("../db", () => ({}))
jest.mock("axios")

const axios = require("axios")
const { getCompanySize } = require("../companySize")

function filler(text) {
    // Pad past the 200-char "looks like a JS SPA shell" threshold so the
    // crawler doesn't try (and fail, since no puppeteer browser is passed) a
    // headless-render fallback.
    return `<html><body><p>${text}</p><p>${"Lorem ipsum dolor sit amet. ".repeat(10)}</p></body></html>`
}

function mockSite(origin, pages) {
    axios.get.mockImplementation(async (url) => {
        const path = url.slice(origin.length) || "/"
        if (Object.prototype.hasOwnProperty.call(pages, path)) {
            return { data: pages[path] }
        }
        return { data: filler("Nothing relevant here.") }
    })
}

beforeEach(() => {
    jest.clearAllMocks()
})

describe("getCompanySize - successful extraction", () => {
    test("finds a range on the About page", async () => {
        const origin = "https://acme-range.test"
        mockSite(origin, {
            "/": filler("Welcome to Acme Inc, makers of fine widgets since 1990."),
            "/about": filler("Our team has grown to 51-200 employees across three offices."),
        })

        const result = await getCompanySize(origin)

        expect(result).toEqual({
            company_size: "51-200 employees",
            source_url: `${origin}/about`,
            status: "found",
        })
    })

    test("finds an em-dash range on the Team page", async () => {
        const origin = "https://acme-dash.test"
        mockSite(origin, {
            "/": filler("Acme homepage."),
            "/about": filler("Nothing here about headcount."),
            "/about-us": filler("Still nothing."),
            "/company": filler("Company overview, no numbers."),
            "/team": filler("We are proud to be a team of 1,001–5,000 employees worldwide."),
        })

        const result = await getCompanySize(origin)

        expect(result.status).toBe("found")
        expect(result.company_size).toBe("1,001-5,000 employees")
        expect(result.source_url).toBe(`${origin}/team`)
    })
})

describe("getCompanySize - different company-size formats", () => {
    test("standalone count is bucketed into a standard range", async () => {
        const origin = "https://acme-count.test"
        mockSite(origin, {
            "/": filler("Acme Corp builds developer tools."),
            "/about": filler("Acme is proud to employ 500 employees around the globe."),
        })

        const result = await getCompanySize(origin)

        expect(result.status).toBe("found")
        expect(result.company_size).toBe("201-500 employees")
    })

    test("'team of N' phrasing is recognized", async () => {
        const origin = "https://acme-team-of.test"
        mockSite(origin, {
            "/": filler("Acme homepage."),
            "/about": filler("We're a scrappy team of 25 based out of Austin."),
        })

        const result = await getCompanySize(origin)

        expect(result.status).toBe("found")
        expect(result.company_size).toBe("11-50 employees")
    })

    test("very large headcount formats as an open-ended '+' range", async () => {
        const origin = "https://acme-enterprise.test"
        mockSite(origin, {
            "/": filler("Acme Global homepage."),
            "/about": filler("Acme Global is a multinational with approximately 12,000 employees."),
        })

        const result = await getCompanySize(origin)

        expect(result.status).toBe("found")
        expect(result.company_size).toBe("10,001+ employees")
    })

    test("JSON-LD numberOfEmployees range takes priority over page text", async () => {
        const origin = "https://acme-jsonld.test"
        const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"Organization","name":"Acme","numberOfEmployees":{"@type":"QuantitativeValue","minValue":1000,"maxValue":5000}}
      </script>
      </head><body><p>${"Lorem ipsum dolor sit amet. ".repeat(10)}</p></body></html>`
        mockSite(origin, { "/": html })

        const result = await getCompanySize(origin)

        expect(result).toEqual({
            company_size: "1,000-5,000 employees",
            source_url: `${origin}/`,
            status: "found",
        })
    })

    test("JSON-LD numberOfEmployees as a plain number", async () => {
        const origin = "https://acme-jsonld-number.test"
        const html = `<html><head>
      <script type="application/ld+json">
        {"@type":"Organization","name":"Acme","numberOfEmployees":42}
      </script>
      </head><body><p>${"Lorem ipsum dolor sit amet. ".repeat(10)}</p></body></html>`
        mockSite(origin, { "/": html })

        const result = await getCompanySize(origin)

        expect(result.status).toBe("found")
        expect(result.company_size).toBe("11-50 employees")
    })
})

describe("getCompanySize - avoids unrelated numbers", () => {
    test("does not mistake customer/founding-year counts for headcount", async () => {
        const origin = "https://acme-noise.test"
        mockSite(origin, {
            "/": filler("Founded in 1998, Acme now serves 5,000+ customers in 12 countries."),
            "/about": filler("We shipped 300 releases and opened 4 offices."),
            "/about-us": filler("Nothing employee-related here either."),
            "/company": filler("Just marketing copy, no headcount."),
            "/team": filler("Meet our leadership - bios only, no numbers."),
        })

        const result = await getCompanySize(origin)

        expect(result).toEqual({ company_size: null, source_url: null, status: "not_found" })
    })
})

describe("getCompanySize - missing information", () => {
    test("returns not_found when no page mentions employee counts", async () => {
        const origin = "https://acme-empty.test"
        mockSite(origin, {
            "/": filler("Acme homepage with no company info."),
            "/about": filler("About page with generic copy."),
            "/about-us": filler("Same as /about."),
            "/company": filler("Company page, no headcount."),
            "/team": filler("Team bios, no numbers."),
        })

        const result = await getCompanySize(origin)

        expect(result).toEqual({ company_size: null, source_url: null, status: "not_found" })
    })
})

describe("getCompanySize - invalid URLs", () => {
    test.each([
        ["not a url", "not a url"],
        ["empty string", ""],
        ["null", null],
        ["undefined", undefined],
        ["ftp scheme", "ftp://files.example.com"],
        ["missing protocol", "example.com"],
    ])("%s is rejected without making any network request", async (_label, input) => {
        const result = await getCompanySize(input)

        expect(result).toEqual({ company_size: null, source_url: null, status: "not_found" })
        expect(axios.get).not.toHaveBeenCalled()
    })
})

describe("getCompanySize - inaccessible websites", () => {
    test("network errors on every candidate page resolve to not_found", async () => {
        axios.get.mockRejectedValue(new Error("connect ECONNREFUSED"))

        const result = await getCompanySize("https://this-site-is-down.test")

        expect(result).toEqual({ company_size: null, source_url: null, status: "not_found" })
    })

    test("DNS/host resolution failure resolves to not_found", async () => {
        axios.get.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"))

        const result = await getCompanySize("https://no-such-domain-xyz123.test")

        expect(result).toEqual({ company_size: null, source_url: null, status: "not_found" })
    })
})
