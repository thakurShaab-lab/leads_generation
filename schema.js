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

        source: varchar("source", { length: 50 }),
        keyword: varchar("keyword", { length: 100 }),
        city: varchar("city", { length: 100 }),
        name: varchar("name", { length: 255 }),
        rating: decimal("rating", { precision: 2, scale: 1 }),
        phone: varchar("phone", { length: 20 }).notNull(),
        address: varchar("address", { length: 500 }),
        website: varchar("website", { length: 255 }),
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

module.exports = { leads, keywords, admin }