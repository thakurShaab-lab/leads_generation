"use strict"

const express = require("express")
const cors = require("cors")
const db = require("./db")
const { sql, eq, gte, lte, and, like } = require("drizzle-orm")
const ExcelJS = require("exceljs")
const scrapeBusinesses = require("./scrapper")
const { leads, keywords, admin } = require("./schema")
const crypto = require("crypto")

const app = express()
const PORT = 3003


const ALLOWED_IPS = [
  "123.63.161.122",
  "14.140.19.35",
  "14.194.4.70",
  "115.241.25.146",
  "115.241.25.148",
  "203.115.97.154",
  "203.115.97.156",
  "14.140.19.38",
  "182.69.118.111",
  "127.0.0.1",
  "::1"
]

const BASE_PATH = "/leads"

const sessionStore = new Map()
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function createSession() {
  const token = crypto.randomBytes(32).toString("hex")
  sessionStore.set(token, Date.now() + SESSION_TTL_MS)
  return token
}

function isValidSession(token) {
  if (!token) return false
  const expiry = sessionStore.get(token)
  if (!expiry) return false
  if (Date.now() > expiry) { sessionStore.delete(token); return false }
  return true
}

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"]
  if (forwarded) return forwarded.split(",")[0].trim()
  return req.socket.remoteAddress || ""
}

function isAllowedIP(req) {
  const ip = getClientIP(req)
  return ALLOWED_IPS.includes(ip)
}

function parseKeyword(input) {
  if (!input) return null
  input = input.trim()
  if (input.toLowerCase().includes(" in ")) {
    const parts = input.split(/ in /i)
    return { keywordPart: parts[0].trim(), locationPart: parts[1].trim() }
  }
  const words = input.split(/\s+/)
  if (words.length < 2) return null
  for (let i = 3; i >= 1; i--) {
    if (words.length > i) {
      const locationPart = words.slice(-i).join(" ")
      const keywordPart = words.slice(0, -i).join(" ")
      if (keywordPart.length > 2 && locationPart.length > 2) {
        return { keywordPart, locationPart }
      }
    }
  }
  return null
}

function getTokenFromCookie(req) {
  const raw = req.headers.cookie || ""
  const match = raw.match(/(?:^|;\s*)auth_token=([^;]+)/)
  return match ? match[1] : null
}

function requireAuth(req, res, next) {
  const token = getTokenFromCookie(req)
  if (isValidSession(token)) return next()
  res.send(renderLoginPage(""))
}

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use((req, res, next) => {
  if (!req.path.startsWith(BASE_PATH)) {
    req.url = BASE_PATH + req.url
  }
  next()
})

app.post([BASE_PATH + "/login", "/login"], async (req, res) => {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      return res.send(renderLoginPage("Username and password are required."))
    }

    const clientIP = getClientIP(req)

    if (!isAllowedIP(req)) {
      return res.send(
        renderLoginPage(
          `Access denied. Your IP (${clientIP}) is not authorised.`
        )
      )
    }

    const result = await db
      .select()
      .from(admin)
      .where(eq(admin.admin_username, username))
      .limit(1)

    if (!result.length) {
      return res.send(renderLoginPage("Invalid username or password."))
    }

    const user = result[0]

    if (user.admin_password !== password) {
      return res.send(renderLoginPage("Invalid username or password."))
    }

    await db
      .update(admin)
      .set({ admin_last_login: new Date() })
      .where(eq(admin.admin_id, user.admin_id))

    const token = createSession()

    res.setHeader(
      "Set-Cookie",
      `auth_token=${token}; HttpOnly; Path=/leads; Max-Age=${SESSION_TTL_MS / 1000}`
    )

    res.redirect("/leads")

  } catch (err) {
    console.error("LOGIN ERROR:", err)
    res.send(renderLoginPage("Something went wrong. Please try again."))
  }
})

app.post([BASE_PATH + "/logout", "/logout"], (req, res) => {
  const token = getTokenFromCookie(req)
  if (token) sessionStore.delete(token)
  res.setHeader("Set-Cookie", `auth_token=; HttpOnly; Path=${BASE_PATH}; Max-Age=0`)
  res.redirect("/leads")
})

app.post(BASE_PATH + "/add-keywords", requireAuth, async (req, res) => {
  try {
    const { keywordInput } = req.body
    if (!keywordInput) return res.status(400).json({ success: false, message: "No keywords provided" })
    const keywordList = keywordInput.split(/,|\n/).map(k => k.trim()).filter(Boolean)
    if (keywordList.length === 0) return res.status(400).json({ success: false, message: "Empty keywords" })
    const values = keywordList.map(k => ({ keyword: k }))
    await db.insert(keywords).values(values)
    res.json({ success: true, message: `Added ${keywordList.length} keyword(s)` })
  } catch (err) {
    console.error("ADD KEYWORDS ERROR:", err)
    res.status(500).json({ success: false, message: "Error adding keywords: " + err.message })
  }
})

app.get(BASE_PATH + "/get-keywords", requireAuth, async (req, res) => {
  try {
    const list = await db.select().from(keywords).orderBy(sql`${keywords.createdAt} DESC`)
    res.json(list)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/leads-count", async (req, res) => {
    try {
        const result = await db.select({ count: sql`count(*)` }).from(leads)
        res.json({ count: Number(result[0].count) })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.delete(BASE_PATH + "/delete-keyword/:id", requireAuth, async (req, res) => {
  try {
    await db.delete(keywords).where(eq(keywords.id, parseInt(req.params.id)))
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post(BASE_PATH + "/run-keyword-scraper", requireAuth, async (req, res) => {
  try {
    const keywordsList = await db.select().from(keywords)
    if (keywordsList.length === 0) return res.json({ success: false, message: "No keywords saved in database" })
    res.json({ success: true, message: `Started scraping ${keywordsList.length} keyword(s)...` });
    (async () => {
      for (let k of keywordsList) {
        if (!k.keyword) continue
        const parsed = parseKeyword(k.keyword)
        if (!parsed) { console.log(`Skipping "${k.keyword}" - invalid format`); continue }
        console.log(`Scraping: ${k.keyword}`)
        await scrapeBusinesses(parsed.keywordPart, [parsed.locationPart])
      }
      console.log("All keyword scraping done")
    })()
  } catch (err) {
    console.error("SCRAPER ERROR:", err)
    res.status(500).json({ success: false, message: "Error: " + err.message })
  }
})

app.post(BASE_PATH + "/run-selected-keywords", requireAuth, async (req, res) => {
  try {
    const { keywords: selectedKeywords } = req.body
    if (!Array.isArray(selectedKeywords) || selectedKeywords.length === 0)
      return res.json({ success: false, message: "No keywords provided" })
    const valid = [], skipped = []
    for (const kw of selectedKeywords) {
      const parsed = parseKeyword(kw)
      if (!parsed) skipped.push(kw)
      else valid.push({ keyword: kw, keywordPart: parsed.keywordPart, locationPart: parsed.locationPart })
    }
    if (valid.length === 0) return res.json({ success: false, message: 'All keywords have invalid format. Must be "Term in City"' })
    res.json({
      success: true,
      message: `Started scraping ${valid.length} keyword(s)...` + (skipped.length ? ` Skipped: ${skipped.join(", ")}` : "")
    });
    (async () => {
      for (const item of valid) {
        console.log(`Scraping: ${item.keyword}`)
        await scrapeBusinesses(item.keywordPart, [item.locationPart])
        console.log(`Done: ${item.keyword}`)
      }
      console.log("Selected keyword scraping done")
    })()
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

app.post(BASE_PATH + "/run-manual-scrape", requireAuth, async (req, res) => {
  try {
    let { keyword, location } = req.body
    let finalKeyword = keyword
    let locations = []
    if (location) {
      locations = location.split(",").map(l => l.trim()).filter(Boolean)
    } else {
      const parsed = parseKeyword(keyword)
      if (!parsed) return res.json({ success: false, message: "Invalid keyword format" })
      finalKeyword = parsed.keywordPart
      locations = [parsed.locationPart]
    }
    res.json({ success: true, message: `Scraping "${keyword}" in ${locations.join(", ")}...` });
    (async () => {
      console.log(`Manual scrape: ${finalKeyword} in ${locations.join(", ")}`)
      await scrapeBusinesses(finalKeyword, locations)
      console.log(`Manual scrape done`)
    })()
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

function buildConditions(filterCity, filterKeyword, fromDate, toDate) {
  const conditions = []

  if (filterCity) {
    conditions.push(eq(leads.city, filterCity))
  }

  if (filterKeyword) {
    conditions.push(like(leads.keyword, `%${filterKeyword}%`))
  }

  // ✅ Use DATE() cast so "2026-04-05" matches any timestamp on that day
  if (fromDate) {
    conditions.push(sql`DATE(${leads.created_at}) >= ${fromDate}`)
  }

  if (toDate) {
    conditions.push(sql`DATE(${leads.created_at}) <= ${toDate}`)
  }

  return conditions
}

// ── Export endpoint ───────────────────────────────────────────────────────────
app.get(BASE_PATH + "/export-leads", requireAuth, async (req, res) => {
  try {
    const { city, filterKeyword, fromDate, toDate } = req.query

    // ✅ Use the shared buildConditions helper (city param = filterCity for export)
    const conditions = buildConditions(city, filterKeyword, fromDate, toDate)

    let query = db.select().from(leads)
    if (conditions.length) {
      query = query.where(and(...conditions))
    }

    const allLeads = await query

    if (!allLeads.length) return res.status(404).send("No leads found for the selected filters")

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet("Leads")

    sheet.columns = [
      { header: "Name", key: "name", width: 30 },
      { header: "Keyword", key: "keyword", width: 25 },
      { header: "City", key: "city", width: 20 },
      { header: "Phone", key: "phone", width: 20 },
      { header: "Website", key: "website", width: 35 },
      { header: "Date", key: "date", width: 25 },
    ]

    allLeads.forEach(l => {
      sheet.addRow({
        name: l.name || "",
        keyword: l.keyword || "",
        city: l.city || "",
        phone: l.phone || "",
        website: l.website || "",
        date: l.created_at ? new Date(l.created_at).toLocaleString("en-IN") : "",
      })
    })

    sheet.getColumn("date").numFmt = "dd-mmm-yyyy hh:mm"

    // Bold header row
    sheet.getRow(1).font = { bold: true }

    // ✅ Dynamic filename reflecting active filters
    let fileName = "leads"
    if (city) fileName += "_" + city
    if (filterKeyword) fileName += "_" + filterKeyword.replace(/\s+/g, "_")
    if (fromDate) fileName += "_from_" + fromDate
    if (toDate) fileName += "_to_" + toDate
    fileName += ".xlsx"

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)

    await workbook.xlsx.write(res)
    res.end()

  } catch (err) {
    console.error("EXPORT ERROR:", err)
    res.status(500).send("Error exporting leads: " + err.message)
  }
})

// ── Login Page ────────────────────────────────────────────────────────────────
function renderLoginPage(errorMsg) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Business Scraper — Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 9999; }
    .login-box { background: #fff; border-radius: 14px; padding: 36px 40px; width: 420px; max-width: 95vw; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }
    .login-logo { font-size: 36px; text-align: center; margin-bottom: 6px; }
    .login-title { font-size: 22px; font-weight: bold; text-align: center; color: #111; margin-bottom: 4px; }
    .login-subtitle { font-size: 13px; color: #888; text-align: center; margin-bottom: 28px; }
    label { display: block; font-size: 13px; font-weight: bold; color: #444; margin-bottom: 5px; margin-top: 16px; }
    input[type=text], input[type=password] { width: 100%; padding: 10px 13px; border: 1px solid #ccc; border-radius: 7px; font-size: 15px; outline: none; }
    input:focus { border-color: #111; }
    .password-wrap { position: relative; }
    .password-wrap input { padding-right: 44px; }
    .toggle-pwd { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 18px; color: #888; padding: 0; }
    .login-btn { margin-top: 24px; width: 100%; padding: 12px; background: #111; color: #fff; border: none; border-radius: 7px; font-size: 16px; font-weight: bold; cursor: pointer; }
    .login-btn:hover { background: #333; }
    .error-msg { margin-top: 16px; background: #fff0f0; color: #c0392b; border: 1px solid #f5c6c6; border-radius: 7px; padding: 10px 14px; font-size: 14px; text-align: center; }
    .lock-icon { text-align: center; margin-top: 22px; font-size: 12px; color: #bbb; }
  </style>
</head>
<body>
  <div class="login-backdrop">
    <div class="login-box">
      <div class="login-logo">&#128640;</div>
      <div class="login-title">Business Scraper</div>
      <div class="login-subtitle">Sign in to access the dashboard</div>
      <form method="POST" action="/leads/login" autocomplete="off">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" placeholder="Enter username" required autofocus />
        <label for="password">Password</label>
        <div class="password-wrap">
          <input type="password" id="password" name="password" placeholder="Enter password" required />
          <button type="button" class="toggle-pwd" onclick="togglePwd()">&#128065;</button>
        </div>
        <button type="submit" class="login-btn">Sign In</button>
        ${errorMsg ? `<div class="error-msg">&#9888; ${errorMsg}</div>` : ""}
      </form>
      <div class="lock-icon">&#128274; Access is restricted to authorised users and IPs only</div>
    </div>
  </div>
  <script>
    function togglePwd() {
      var inp = document.getElementById('password');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }
  </script>
</body>
</html>`
}

// ── Main HTML renderer ────────────────────────────────────────────────────────
function renderHTML(data, totalLeads, page, totalPages, keyword, locationInput, citiesList, selectedCity, filterKeyword, fromDate, toDate) {
  const rows = data.map((l, i) => {
    const num = (page - 1) * 10 + i + 1
    const name = (l.name || "").replace(/</g, "&lt;")
    const kw = (l.keyword || "").replace(/</g, "&lt;")
    const city = (l.city || "").replace(/</g, "&lt;")
    const phone = (l.phone || "").replace(/</g, "&lt;")
    const website = l.website ? `<a href="${l.website}" target="_blank">Visit</a>` : "&mdash;"
    const date = l.created_at ? new Date(l.created_at).toLocaleString("en-IN") : ""
    return `<tr><td>${num}</td><td>${name || "&mdash;"}</td><td>${kw || "&mdash;"}</td><td>${city || "&mdash;"}</td><td>${phone || "&mdash;"}</td><td>${website}</td><td>${date}</td></tr>`
  }).join("")

  const cityOptions = citiesList.map(city =>
    `<option value="${city}"${selectedCity === city ? " selected" : ""}>${city}</option>`
  ).join("")

  const maxVisible = 5
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2))
  let endPage = startPage + maxVisible - 1
  if (endPage > totalPages) { endPage = totalPages; startPage = Math.max(1, endPage - maxVisible + 1) }

  const extraParams =
    (selectedCity ? "&filterCity=" + selectedCity : "") +
    (filterKeyword ? "&filterKeyword=" + encodeURIComponent(filterKeyword) : "") +
    (fromDate ? "&fromDate=" + fromDate : "") +
    (toDate ? "&toDate=" + toDate : "") +
    (keyword ? "&keyword=" + encodeURIComponent(keyword) : "") +
    (locationInput ? "&location=" + encodeURIComponent(locationInput) : "")

  let pageLinks = ""
  if (page > 1) pageLinks += `<a href="?page=${page - 1}${extraParams}">&larr; Prev</a>`
  for (let i = startPage; i <= endPage; i++) {
    pageLinks += i === page ? `<a class="active">${i}</a>` : `<a href="?page=${i}${extraParams}">${i}</a>`
  }
  if (page < totalPages) pageLinks += `<a href="?page=${page + 1}${extraParams}">Next &rarr;</a>`

  // Show active filter badges
  const activeBadges = []
  if (selectedCity) activeBadges.push(`City: <strong>${selectedCity}</strong>`)
  if (filterKeyword) activeBadges.push(`Keyword: <strong>${filterKeyword}</strong>`)
  if (fromDate) activeBadges.push(`From: <strong>${fromDate}</strong>`)
  if (toDate) activeBadges.push(`To: <strong>${toDate}</strong>`)
  const filterBadgeHTML = activeBadges.length
    ? `<div style="margin-bottom:12px;font-size:13px;color:#555;">Active filters: ${activeBadges.join(" &nbsp;|&nbsp; ")} &nbsp;<a href="/leads" style="color:#c0392b;font-size:12px;">✕ Clear all</a></div>`
    : ""

  return `<!DOCTYPE html>
<html>
<head>
  <title>Business Scraper</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background: #f0f2f5; margin: 0; padding: 20px; }
    h2 { color: #111; } h3 { color: #333; margin-top: 0; }
    .card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .row { display: flex; gap: 16px; flex-wrap: wrap; }
    .col { flex: 1; min-width: 280px; }
    input[type=text], input:not([type]), textarea, select { padding: 9px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; width: 100%; margin-bottom: 8px; }
    input[type=date] { padding: 9px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; width: 100%; margin-bottom: 8px; }
    button { padding: 9px 18px; background: #111; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; margin-right: 6px; margin-top: 4px; }
    button:hover { background: #333; }
    button.secondary { background: #555; } button.danger { background: #c0392b; } button.success { background: #27ae60; }
    a { text-decoration: none; color: #2980b9; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #111; color: white; padding: 10px; text-align: left; }
    td { border-bottom: 1px solid #eee; padding: 10px; font-size: 14px; }
    tr:hover td { background: #fafafa; }
    .pagination { margin-top: 16px; }
    .pagination a { padding: 6px 14px; background: #eee; border-radius: 4px; margin: 0 4px; color: #111; display: inline-block; }
    .pagination a.active { background: #111; color: white; font-weight: bold; }
    .status-bar { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; border-radius: 6px; padding: 10px 16px; margin-bottom: 16px; display: none; font-size: 14px; }
    .status-bar.error { background: #f8d7da; color: #721c24; border-color: #f5c6cb; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; }
    .modal { background: white; border-radius: 12px; padding: 28px; width: 460px; max-width: 95vw; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
    .modal h3 { margin-top: 0; }
    .modal-close { float: right; background: none; border: none; font-size: 20px; cursor: pointer; color: #555; padding: 0; margin: 0; }
    .modal-close:hover { color: #111; background: none; }
    .section-label { font-size: 12px; font-weight: bold; text-transform: uppercase; color: #888; letter-spacing: 0.5px; margin-bottom: 8px; }
    .divider { border: none; border-top: 1px solid #eee; margin: 20px 0; }
    .keyword-list { max-height: 200px; overflow-y: auto; border: 1px solid #ccc; border-radius: 6px; padding: 4px 10px; margin-bottom: 8px; background: #fafafa; }
    .keyword-list label { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 14px; cursor: pointer; border-bottom: 1px solid #eee; }
    .keyword-list label:last-child { border-bottom: none; }
    .keyword-list input[type=checkbox] { width: 15px; height: 15px; min-width: 15px; margin: 0; padding: 0; cursor: pointer; accent-color: #111; }
    .keyword-list-empty { font-size: 13px; color: #888; padding: 8px 0; }
    .kw-select-all-row { display: flex; gap: 10px; margin-bottom: 6px; font-size: 13px; align-items: center; }
    .kw-select-all-row a { cursor: pointer; color: #2980b9; text-decoration: underline; }
    .kw-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    #loaderOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: none; align-items: center; justify-content: center; z-index: 2000; }
    .loader-box { background: white; padding: 30px 36px; border-radius: 12px; text-align: center; min-width: 240px; }
    .spinner { width: 40px; height: 40px; border: 4px solid #ddd; border-top: 4px solid #111; border-radius: 50%; animation: spin 0.9s linear infinite; margin: 0 auto 14px; }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    #loaderText { font-size: 14px; color: #333; }
  </style>
</head>
<body>

  <div id="loaderOverlay">
    <div class="loader-box">
      <div class="spinner"></div>
      <div id="loaderText">Processing...</div>
    </div>
  </div>

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
    <h2>&#128640; Business Scraper Dashboard</h2>
    <div style="display:flex;gap:10px;align-items:center;">
      <button onclick="openFilterModal()" style="background:#2980b9;padding:8px 16px;font-size:13px;border-radius:20px;">🔍 Filters</button>
      <form method="POST" action="${BASE_PATH}/logout" style="margin:0;">
        <button type="submit" style="background:#c0392b;padding:8px 16px;font-size:13px;">&#128274; Logout</button>
      </form>
    </div>
  </div>

  <div class="status-bar" id="statusBar"></div>

  <div class="row">
    <div class="col card">
      <h3>&#128278; Keyword Management</h3>
      <div class="section-label">Saved Keywords</div>
      <div class="kw-select-all-row">
        <a onclick="selectAllKeywords()">Select All</a>
        <span style="color:#ccc;">|</span>
        <a onclick="deselectAllKeywords()">Deselect All</a>
        <span id="selectedCount" style="margin-left:auto;color:#555;font-size:12px;">0 selected</span>
      </div>
      <div class="keyword-list" id="keywordList">
        <div class="keyword-list-empty">Loading...</div>
      </div>
      <div class="kw-actions">
        <button onclick="searchSelectedKeywords()">&#128269; Search Selected</button>
        <button class="danger" onclick="deleteSelectedKeyword()">&#128465; Delete</button>
      </div>
      <hr class="divider" style="margin:14px 0;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="openModal()">&#10133; Add Keywords</button>
        <button class="success" onclick="runAllKeywords()">&#9654; Run All</button>
        <button onclick="openKeywordViewer()">👁 View All Keywords</button>
      </div>
    </div>

    <div class="col card">
      <h3>&#128269; Manual Search</h3>
      <div class="section-label">Enter keyword &amp; location to scrape now</div>
      <input type="text" id="manualKeyword" placeholder="e.g. Doctor" value="${keyword || ""}" />
      <input type="text" id="manualLocation" placeholder="e.g. Delhi, Gurgaon" value="${locationInput || ""}" />
      <button onclick="handleManualSearch()">Search &amp; Scrape</button>
      <hr class="divider">
      <div class="section-label">Filter leads by city</div>
      <form method="GET">
        <select name="filterCity">
          <option value="">All Cities</option>
          ${cityOptions}
        </select>
        <button type="submit" style="margin-top:8px;">Filter</button>
      </form>
    </div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      <h3 style="margin:0;">&#128203; Leads &nbsp;<span style="font-weight:normal;font-size:15px;color:#555;">(Total: ${totalLeads})</span></h3>
      <div style="display:flex;gap:8px;">
        <button onclick="downloadFilteredLeads()">⬇ Export Filtered</button>
        <button onclick="downloadAllLeads()">⬇ Export All</button>
      </div>
    </div>
    ${filterBadgeHTML}
    <table>
      <tr><th>#</th><th>Name</th><th>Keyword</th><th>City</th><th>Phone</th><th>Website</th><th>Date</th></tr>
      ${data.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:#888;padding:30px;">No leads found</td></tr>' : rows}
    </table>
    <div class="pagination">${pageLinks}</div>
  </div>

  <!-- ADD KEYWORDS MODAL -->
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&#10005;</button>
      <h3>&#10133; Add Keywords</h3>
      <p style="color:#555;font-size:14px;margin-top:0;">Format: <code>Business Type in City</code><br>e.g. <em>Doctor in Delhi, Dentist in Gurgaon</em><br>One per line or comma-separated.</p>
      <textarea id="keywordInput" placeholder="Doctor in Delhi" style="height:120px;"></textarea>
      <div style="margin-top:12px;">
        <button onclick="submitKeywords()">Save Keywords</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
      <div id="modalStatus" style="margin-top:12px;font-size:14px;"></div>
    </div>
  </div>

  <!-- VIEW KEYWORDS MODAL -->
  <div class="modal-overlay" id="keywordViewerOverlay">
    <div class="modal">
      <button class="modal-close" onclick="closeKeywordViewer()">✕</button>
      <h3>📋 All Saved Keywords</h3>
      <div id="keywordViewerList" style="max-height:300px;overflow-y:auto;margin-top:10px;">Loading...</div>
      <div style="margin-top:15px;"><button onclick="closeKeywordViewer()">Close</button></div>
    </div>
  </div>

  <!-- FILTER MODAL -->
  <div class="modal-overlay" id="filterModal">
    <div class="modal">
      <button class="modal-close" onclick="closeFilterModal()">✕</button>
      <h3>🔍 Filter Leads</h3>
      <label>Keyword</label>
      <input type="text" id="filterKeyword" placeholder="e.g. Doctor" value="${filterKeyword || ""}" />
      <label>From Date</label>
      <input type="date" id="fromDate" value="${fromDate || ""}" />
      <label>To Date</label>
      <input type="date" id="toDate" value="${toDate || ""}" />
      <div style="margin-top:15px;">
        <button onclick="applyFilters()">Apply</button>
        <button class="secondary" onclick="clearFilters()">Clear All</button>
        <button class="secondary" onclick="closeFilterModal()">Cancel</button>
      </div>
    </div>
  </div>

  <script>
  var BASE = '/leads';

    function showLoader(text) {
      document.getElementById('loaderOverlay').style.display = 'flex';
      document.getElementById('loaderText').textContent = text || 'Processing...';
    }
    function hideLoader() { document.getElementById('loaderOverlay').style.display = 'none'; }
    function updateLoaderText(text) { document.getElementById('loaderText').textContent = text; }

    function showStatus(msg, isError) {
      var bar = document.getElementById('statusBar');
      bar.textContent = msg;
      bar.style.display = 'block';
      bar.className = 'status-bar' + (isError ? ' error' : '');
      clearTimeout(window._st);
      window._st = setTimeout(function(){ bar.style.display = 'none'; }, 8000);
    }

    function pollUntilNewData(baselineCount, labelText, timeoutMs) {
      var deadline = Date.now() + (timeoutMs || 300000);
      var dots = 0;
      function tick() {
        dots = (dots + 1) % 4;
        updateLoaderText((labelText || 'Scraping') + '.'.repeat(dots + 1));
        if (Date.now() > deadline) {
          hideLoader();
          showStatus('Scraping timed out. Reloading to show latest data.', true);
          setTimeout(function(){ location.reload(); }, 1500);
          return;
        }
        fetch(BASE + '/leads-count')
          .then(function(r){ return r.json(); })
          .then(function(data) {
            if (data.count > baselineCount) { updateLoaderText('Loading new data...'); location.reload(); }
            else setTimeout(tick, 2000);
          })
          .catch(function() { setTimeout(tick, 3000); });
      }
      setTimeout(tick, 2000);
    }

    function scrapeWithPolling(action, loaderText) {
      showLoader('Starting...');
      fetch(BASE + '/leads-count')
        .then(function(r){ return r.json(); })
        .then(function(countData) {
          var baseline = countData.count;
          return action().then(function(result) {
            if (!result.success) { hideLoader(); showStatus('Error: ' + result.message, true); return; }
            showLoader(loaderText || 'Scraping');
            pollUntilNewData(baseline, loaderText || 'Scraping');
          });
        })
        .catch(function(e) { hideLoader(); showStatus('Network error: ' + e.message, true); });
    }

    function loadKeywords() {
      fetch(BASE + '/get-keywords')
        .then(function(r){ return r.json(); })
        .then(function(list) {
          var container = document.getElementById('keywordList');
          if (!list.length) { container.innerHTML = '<div class="keyword-list-empty">No keywords saved yet</div>'; updateSelectedCount(); return; }
          container.innerHTML = '';
          list.forEach(function(k) {
            var label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
            var left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px;';
            var cb = document.createElement('input');
            cb.type = 'checkbox'; cb.value = k.keyword; cb.dataset.id = k.id;
            cb.addEventListener('change', updateSelectedCount);
            var text = document.createElement('span');
            text.textContent = k.keyword;
            left.appendChild(cb); left.appendChild(text);
            var right = document.createElement('span');
            right.style.cssText = 'font-size:12px;color:#888;';
            right.textContent = k.created_at ? new Date(k.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '';
            label.appendChild(left); label.appendChild(right);
            container.appendChild(label);
          });
          updateSelectedCount();
        })
        .catch(function(e){ console.error('loadKeywords error:', e); });
    }

    function getCheckedKeywords() {
      return Array.from(document.querySelectorAll('#keywordList input[type=checkbox]:checked')).map(function(cb){ return cb.value; });
    }
    function updateSelectedCount() {
      var n = document.querySelectorAll('#keywordList input[type=checkbox]:checked').length;
      document.getElementById('selectedCount').textContent = n + ' selected';
    }
    function selectAllKeywords() { document.querySelectorAll('#keywordList input[type=checkbox]').forEach(function(cb){ cb.checked = true; }); updateSelectedCount(); }
    function deselectAllKeywords() { document.querySelectorAll('#keywordList input[type=checkbox]').forEach(function(cb){ cb.checked = false; }); updateSelectedCount(); }

    loadKeywords();

    function openModal() { document.getElementById('modalOverlay').style.display = 'flex'; document.getElementById('keywordInput').value = ''; document.getElementById('modalStatus').textContent = ''; }
    function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }
    document.getElementById('modalOverlay').addEventListener('click', function(e){ if (e.target === this) closeModal(); });

    function submitKeywords() {
      var val = document.getElementById('keywordInput').value.trim();
      var status = document.getElementById('modalStatus');
      if (!val) { status.textContent = 'Please enter at least one keyword.'; return; }
      status.textContent = 'Saving...';
      fetch(BASE + '/add-keywords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywordInput: val }) })
        .then(function(r){ return r.json(); })
        .then(function(data) {
          if (data.success) { status.style.color = 'green'; status.textContent = 'Saved! ' + data.message; loadKeywords(); setTimeout(closeModal, 1200); }
          else { status.style.color = 'red'; status.textContent = 'Error: ' + data.message; }
        })
        .catch(function(e){ status.style.color = 'red'; status.textContent = 'Network error: ' + e.message; });
    }

    function searchSelectedKeywords() {
      var selected = getCheckedKeywords();
      if (selected.length === 0) { showStatus('Please check at least one keyword first.', true); return; }
      var label = 'Scraping ' + selected.length + ' keyword' + (selected.length > 1 ? 's' : '');
      scrapeWithPolling(function() {
        return fetch(BASE + '/run-selected-keywords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: selected }) }).then(function(r){ return r.json(); });
      }, label);
    }

    function deleteSelectedKeyword() {
      var checked = Array.from(document.querySelectorAll('#keywordList input[type=checkbox]:checked'));
      if (checked.length === 0) { showStatus('Please check at least one keyword to delete.', true); return; }
      if (!confirm('Delete ' + checked.length + ' keyword(s)?')) return;
      var i = 0;
      function deleteNext() {
        if (i >= checked.length) { showStatus('Deleted ' + checked.length + ' keyword(s).'); loadKeywords(); return; }
        fetch(BASE + '/delete-keyword/' + checked[i].dataset.id, { method: 'DELETE' }).then(function(r){ return r.json(); }).then(function(){ i++; deleteNext(); }).catch(function(e){ showStatus('Error deleting: ' + e.message, true); });
      }
      deleteNext();
    }

    function runAllKeywords() {
      if (!confirm('Run scraper for ALL saved keywords?')) return;
      scrapeWithPolling(function() { return fetch(BASE + '/run-keyword-scraper', { method: 'POST' }).then(function(r){ return r.json(); }); }, 'Scraping all keywords');
    }

    function handleManualSearch() {
      var kw = document.getElementById('manualKeyword').value.trim();
      var loc = document.getElementById('manualLocation').value.trim();
      if (!kw || !loc) { showStatus('Please enter both a keyword and a location.', true); return; }
      scrapeWithPolling(function() {
        return fetch(BASE + '/run-manual-scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: kw, location: loc }) }).then(function(r){ return r.json(); });
      }, 'Scraping "' + kw + '" in ' + loc);
    }

    function openKeywordViewer() {
      var overlay = document.getElementById('keywordViewerOverlay');
      overlay.style.display = 'flex';
      overlay.onclick = function(e){ if (e.target === overlay) closeKeywordViewer(); };
      loadKeywordViewer();
    }
    function closeKeywordViewer() { document.getElementById('keywordViewerOverlay').style.display = 'none'; }
    function loadKeywordViewer() {
      var container = document.getElementById('keywordViewerList');
      container.innerHTML = 'Loading...';
      fetch(BASE + '/get-keywords').then(function(r){ return r.json(); }).then(function(list) {
        if (!list.length) { container.innerHTML = '<div style="color:#888;">No keywords found</div>'; return; }
        container.innerHTML = list.map(function(k, i) {
          var date = k.created_at ? new Date(k.created_at).toLocaleDateString() : '';
          return '<div style="padding:8px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;"><div><strong>' + (i+1) + '.</strong> ' + k.keyword + '</div><div style="font-size:12px;color:#888;">' + date + '</div></div>';
        }).join('');
      }).catch(function(){ container.innerHTML = '<div style="color:red;">Error loading keywords</div>'; });
    }

    // ✅ Export filtered: passes current active filters (city, keyword, fromDate, toDate)
    function downloadFilteredLeads() {
      var params = new URLSearchParams(window.location.search);
      // rename filterCity → city for the export endpoint
      var city = params.get('filterCity');
      if (city) { params.set('city', city); params.delete('filterCity'); }
      window.open(BASE + '/export-leads?' + params.toString(), '_blank');
    }

    // ✅ Export all: no filters
    function downloadAllLeads() {
      window.open(BASE + '/export-leads', '_blank');
    }

    function openFilterModal() { document.getElementById('filterModal').style.display = 'flex'; }
    function closeFilterModal() { document.getElementById('filterModal').style.display = 'none'; }

    // ✅ applyFilters preserves existing filterCity selection
    function applyFilters() {
      var params = new URLSearchParams(window.location.search);
      var keyword = document.getElementById('filterKeyword').value;
      var fromDate = document.getElementById('fromDate').value;
      var toDate = document.getElementById('toDate').value;
      if (keyword) params.set('filterKeyword', keyword); else params.delete('filterKeyword');
      if (fromDate) params.set('fromDate', fromDate); else params.delete('fromDate');
      if (toDate) params.set('toDate', toDate); else params.delete('toDate');
      params.delete('page'); // reset to page 1 on new filter
      window.location.search = params.toString();
    }

    function clearFilters() {
      window.location.href = '/leads';
    }

    // ✅ Pre-fill filter modal with current active values
    ;(function() {
      var params = new URLSearchParams(window.location.search);
      var kw = params.get('filterKeyword');
      var fd = params.get('fromDate');
      var td = params.get('toDate');
      if (kw) document.getElementById('filterKeyword').value = kw;
      if (fd) document.getElementById('fromDate').value = fd;
      if (td) document.getElementById('toDate').value = td;
    })();
  </script>
</body>
</html>`
}

app.get(["/", BASE_PATH], requireAuth, async (req, res) => {
  const keyword = req.query.keyword
  const locationInput = req.query.location
  const filterCity = req.query.filterCity
  const filterKeyword = req.query.filterKeyword
  const fromDate = req.query.fromDate
  const toDate = req.query.toDate
  const page = parseInt(req.query.page) || 1
  const limit = 10

  try {
    const citiesResult = await db.select({ city: leads.city }).from(leads)
    const citiesList = [...new Set(citiesResult.map(c => c.city).filter(Boolean))]
    const conditions = buildConditions(filterCity, filterKeyword, fromDate, toDate)
    let query = db.select().from(leads)
    let countQuery = db.select({ count: sql`count(*)` }).from(leads)
    if (conditions.length) {
      query = query.where(and(...conditions))
      countQuery = countQuery.where(and(...conditions))
    }
    const totalResult = await countQuery
    const totalLeads = Number(totalResult[0].count)
    const totalPages = Math.ceil(totalLeads / limit) || 1
    const result = await query.limit(limit).offset((page - 1) * limit)
    res.send(renderHTML(result, totalLeads, page, totalPages, keyword, locationInput, citiesList, filterCity, filterKeyword, fromDate, toDate))
  } catch (err) {
    console.error(err)
    res.send(`<h3>Error</h3><pre>${err.message}</pre>`)
  }
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`)
})