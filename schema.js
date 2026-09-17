const { mysqlTable, int, varchar, decimal, datetime, uniqueIndex, timestamp } = require("drizzle-orm/mysql-core")

const admin = mysqlTable("admin", {
    admin_id: int("admin_id").primaryKey().autoincrement(),

    admin_username: varchar("admin_username", { length: 50 }).notNull(),

    admin_password: varchar("admin_password", { length: 30 }),

    admin_email: varchar("admin_email", { length: 255 }).notNull(),

    weight_price: varchar("weight_price", { length: 55 }),

    litigation_days: int("litigation_days"),

    admin_last_login: datetime("admin_last_login")
        .notNull()
        .default("0000-00-00 00:00:00"),
})


const leads = mysqlTable(
    "scrap_data",
    {
        id: int("id").primaryKey().autoincrement(),
        keyword_id: int("keyword_id"),
        source: varchar("source", { length: 50 }),
        keyword: varchar("keyword", { length: 100 }),
        city: varchar("city", { length: 100 }),
        name: varchar("name", { length: 255 }),
        rating: decimal("rating", { precision: 2, scale: 1 }),
        reviews_count: int("reviews_count"),
        phone: varchar("phone", { length: 20 }).notNull(),
        address: varchar("address", { length: 500 }),
        website: varchar("website", { length: 255 }),
        country_code: varchar("country_code", { length: 10 }),
        dial_code: varchar("dial_code", { length: 10 }),
        employee_count: int("employee_count"),
        employee_range: varchar("employee_range", { length: 20 }),
        size_source_url: varchar("size_source_url", { length: 500 }),
        created_at: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => {
        return {
            phoneUnique: uniqueIndex("phone_unique_idx").on(table.phone),
        }
    }
)

const keywords = mysqlTable("keywords", {
    id: int("id").primaryKey().autoincrement(),
    keyword: varchar("keyword", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
})

// Domain-level cache of company-size crawl results, so the same company
// website is never re-crawled on every scrape run that happens to surface it.
const companySizeCache = mysqlTable(
    "company_size_cache",
    {
        id: int("id").primaryKey().autoincrement(),
        domain: varchar("domain", { length: 255 }).notNull(),
        employee_count: int("employee_count"),
        employee_range: varchar("employee_range", { length: 20 }),
        size_source_url: varchar("size_source_url", { length: 500 }),
        status: varchar("status", { length: 20 }).notNull(),
        checked_at: timestamp("checked_at").defaultNow().notNull(),
    },
    (table) => {
        return {
            domainUnique: uniqueIndex("domain_unique_idx").on(table.domain),
        }
    }
)

module.exports = { leads, keywords, admin, companySizeCache }