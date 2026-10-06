import { readdir, readFile } from 'fs/promises'
import { env } from 'process'
import { Pool, types } from 'pg'
import { migrate } from "postgres-migrations"
import * as Slonik from 'slonik'
import { onceGlobally } from './util_server'

export const sql = Slonik.sql


export async function init() {
    console.log("Initialize DB...")
    await teardownViews()
    await migrate({ client: pool }, "migrations/")
    await setupViews()
    console.log("DB initialized successfully")
}

// only for testing, to stop DB connections before deleting the DB
export async function deinit() {
    await pool.end()
    await spool.end()
}

function teardownViews() {
    // run only the first view file, which is the clean/teardown script
    return setupViews(0, 1)
}

async function setupViews(from_index: number = 1, below_index: number = Number.MAX_SAFE_INTEGER) {
    // default values run all views except for the first one, which is the clean/teardown script

    const views_files = await readdir("db_views")
    views_files.sort()
    let count = 0

    let current_file = ""
    try {
        const max_index = Math.min(below_index, views_files.length)
        for (let i = from_index; i < max_index; i++) {
            const file = views_files[i];
            current_file = file
            const view = await readFile(`db_views/${file}`, "utf8")
                .catch(console.error)
            if (view) {
                await query(view)
                count++
            }
        }
    } catch (e) {
        console.error("The following error happened when processing view file: ", current_file)
        throw e
    }
    console.log(`Processed ${count} view files.`)
}

export const pool = onceGlobally("/src/db.ts/pool", () => new Pool({
    host: env.DB_HOST ?? '0.0.0.0',
    port: env.DB_PORT != null ? +env.DB_PORT : undefined,
    database: env.DB_NAME ?? 'carrot_db',
    user: env.DB_USERNAME ?? 'postgres',
    password: env.DB_PASSWORD ?? '',
    min: Number(env.DB_POOL_MIN),
    max: Number(env.DB_POOL_MAX ?? 30)
}))



// dates/times need to be turned into strings to transfer them as props anyways
// by disabling the parser for them in pg, we save 2 transformations
types.setTypeParser(types.builtins.TIMESTAMP, String)
types.setTypeParser(types.builtins.TIMESTAMPTZ, String)
types.setTypeParser(types.builtins.TIMETZ, String)
types.setTypeParser(types.builtins.DATE, String)
types.setTypeParser(types.builtins.NUMERIC, Number)
types.setTypeParser(types.builtins.INTERVAL, String)


export const spool = await onceGlobally("/src/db.ts/spool", () => Slonik.createPool(
    `postgres://${env.DB_USERNAME ?? 'postgres'}:${env.DB_PASSWORD ?? ''}@${env.DB_HOST ?? '0.0.0.0'}:${env.DB_PORT ?? "5432"}/${env.DB_NAME ?? 'carrot_db'}`,
    {
        captureStackTrace: env.ROARR_LOG === "true",
        typeParsers: [
            {
                name: 'timestamptz',
                parse: String
            },
            {
                name: 'timestamp',
                parse: String
            },
            {
                name: 'numeric',
                parse: Number
            },
            {
                name: 'interval',
                parse: String
            }
        ],
        maximumPoolSize: Number(process.env.DB_POOL_MAX ?? 30)
    }
)
    .catch(e => {
        console.error("Error when creating pool: ", e)
        return null
    }) as Promise<Slonik.DatabasePool>)

export const no_tx = spool as Slonik.CommonQueryMethods

export async function query(query: string, params?: any[]) {
    return pool.query(query, params)
}

export async function queryAll<T = any>(query: string, params?: any[]): Promise<T[]> {
    const result = await pool.query(query, params)
    return result.rows
}

export async function queryFirst<T = any>(query: string, params?: any[]): Promise<T | undefined> {
    const result = await pool.query(query, params)
    return result.rows[0]
}

export default pool