const mysql = require("mysql2/promise")
const { drizzle } = require("drizzle-orm/mysql2")
require("dotenv").config()

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 10,
})

async function testConnection() {
  try {
    const connection = await pool.getConnection()
    console.log("✅ Database connected successfully")
    connection.release()
  } catch (error) {
    console.error("❌ Database connection failed:", error.message)
  }
}

testConnection()

const db = drizzle(pool)

module.exports = db