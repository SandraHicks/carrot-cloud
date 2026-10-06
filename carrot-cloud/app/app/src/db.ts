import { readdir, readFile } from 'fs/promises'
import { env } from 'process'
import { Pool, types } from 'pg'
import { migrate } from "postgres-migrations"
import * as Slonik from 'slonik'
import { onceGlobally } from './util_server'
import type { Moment } from 'moment'

const sq = Slonik.sql

export type SaneSlonikQueryMethods = {
    any: <T extends {}>(sql: Slonik.TaggedTemplateLiteralInvocation<T>, values?: PrimitiveValueExpression[]) => Promise<T[]>,
    anyFirst: <T extends {}, Row extends Record<string, unknown> = Record<string, T>>(sql: Slonik.TaggedTemplateLiteralInvocation<Row>, values?: PrimitiveValueExpression[]) => Promise<(Row[keyof Row])[]>,
    transaction: <T>(callback: (connection: SaneSlonikTransaction) => Promise<T>) => Promise<T>,
}

export type SaneSlonikTransaction = Merge<Slonik.CommonQueryMethods, SaneSlonikQueryMethods>
export type SaneSlonikPool = Merge<Slonik.DatabasePool, SaneSlonikQueryMethods>

export function isSlonikArrayWrapper(x: object): x is ReturnType<typeof sql.array> {
    return "type" in x && x.type === "SLONIK_TOKEN_ARRAY"
}

export function isSlonikSQLWrapper(x: object): x is ReturnType<typeof sql> {
    return "type" in x && x.type === "SLONIK_TOKEN_SQL"
}

export function sqlify_value(value: unknown): Slonik.ValueExpression {
    if (value === null) return null // null is also "object" so it needs a special check
    if (value === undefined) return sql`DEFAULT`
    if ("isoWeeksInISOWeekYear" in value["__proto__"]) // probably a moment
        return (value as Moment).toJSON()
    if (value instanceof Date) return value.toJSON()

    // arrays are also objects, but JSONing them is fine
    if (typeof value === 'object') {
        if (isSlonikArrayWrapper(value) || isSlonikSQLWrapper(value))
            return value
        return JSON.stringify(value)
    }
    return value as Slonik.ValueExpression
}

type TOrFragments<T> = Shuffle<T, {
    [K in keyof T]: Slonik.TaggedTemplateLiteralInvocation<Slonik.QueryResultRow>
}>

type PartialOrFragments<T> = VeryPartial<TOrFragments<T>>

export const sql = Object.assign(
    //logging_sql as typeof sq,
    sq.bind(null) as typeof sq, // "clone" the function so we don't modify the original
    sq,                         // Slonik.sql is more than just a function, so add that stuff back
    sql_addons                  // add our own secret-sauce to it
)

function sql_insert<T extends {}, R extends {}>(table: string, value: PartialOrFragments<T>, returning?: Slonik.TaggedTemplateLiteralInvocation<R>): Slonik.TaggedTemplateLiteralInvocation<R>
function sql_insert<T extends {}>(table: string, value: PartialOrFragments<T>, returning?: null): Slonik.TaggedTemplateLiteralInvocation<{}>
function sql_insert<T extends {}, R extends {}>(table: string, value: PartialOrFragments<T>, returning: MaybeReturning<R> = sq<R>`*`) {
    const maybe_returning = returning != null
        ? sql`RETURNING ${returning}`
        : sql``

    return sq<R>`
        INSERT INTO ${sq.identifier([table])}
            (${sq.join(Object.keys(value).map(k => sq`${sq.identifier([k])}`), sq`, `)})
        VALUES
            (${sq.join(Object.keys(value).map(k => sqlify_value(value[k])), sq`, `)})
        ${maybe_returning}
    `
}

type MaybeReturning<R extends Slonik.QueryResultRow = Record<string, any>> = Slonik.TaggedTemplateLiteralInvocation<R> | null
const sql_addons = {
    all<T extends {}>(table: string) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        return sq`SELECT * FROM ${sq.identifier([table])}` as Slonik.TaggedTemplateLiteralInvocation<T>
    },
    allWhere<T extends {}>(table: string, where: { [k in keyof T]?: unknown }) {
        return sq`
            SELECT * FROM ${sq.identifier([table])}
            WHERE ${sq.join(Object.keys(where).map(k => sq`${sq.identifier([table, k])} = ${sqlify_value(where[k])}`), sq` AND `)}
        ` as Slonik.TaggedTemplateLiteralInvocation<T>
    },
    drop<T extends {}>(table: string, where: { [k in keyof T]?: unknown }) {
        return sq`
            DELETE FROM ${sq.identifier([table])}
            WHERE ${sq.join(Object.keys(where).map(k => sq`${sq.identifier([table, k])} = ${sqlify_value(where[k])}`), sq` AND `)}
        `
    },
    upsert<T extends {}>(table: string, value: TOrFragments<T>, conflict: (keyof T)[], returning: Slonik.TaggedTemplateLiteralInvocation | null = null) {
        const update_keys = Object.keys(value).filter(k => !conflict.includes(k as keyof T))
        const resolution = (update_keys.length === 0)
            ? sql`DO NOTHING`
            : sql`DO UPDATE SET
                ${sq.join(update_keys.map(k => sq`${sq.identifier([k])} = EXCLUDED.${sq.identifier([k])}`), sq`, `)}`
        const maybe_returning = (returning != null) ? sq`RETURNING ${returning}` : sq``

        return sq`
            INSERT INTO ${sq.identifier([table])}
                (${sq.join(Object.keys(value).map(k => sq`${sq.identifier([k])}`), sq`, `)})
            VALUES
                (${sq.join(Object.keys(value).map(k => sqlify_value(value[k])), sq`, `)})
            ON CONFLICT (${sq.join(conflict.map(c => sq.identifier([c as string])), sq`, `)})
                ${resolution}
            ${maybe_returning}
        `
    },
    upsertMany<T extends {}>(table: string, values: readonly PartialOrFragments<T>[], conflict: (keyof T)[], returning: Slonik.TaggedTemplateLiteralInvocation | null = null) {
        if (values.length === 0) return sq`SELECT 1 WHERE 1 = 0` // return nothing (empty set)

        const keys = Object.keys(values[0])
        const update_keys = keys.filter(k => !conflict.includes(k as keyof T))
        const resolution = (update_keys.length === 0)
            ? sql`DO NOTHING`
            : sql`DO UPDATE SET
                ${sq.join(update_keys.map(k => sq`${sq.identifier([k])} = EXCLUDED.${sq.identifier([k])}`), sq`, `)}`
        const maybe_returning = (returning != null) ? sq`RETURNING ${returning}` : sq``

        const inner_values = values.map(v => sq`(${sq.join(keys.map(k => sqlify_value(v[k]) ?? null), sq`, `)})`)

        return sq`
        INSERT INTO ${sq.identifier([table])}
            (${sq.join(Object.keys(values[0]).map(k => sq`${sq.identifier([k])}`), sq`, `)})
        VALUES
            ${sq.join(inner_values, sq`, `)}
        ON CONFLICT (${sq.join(conflict.map(c => sq.identifier([c as string])), sq`, `)})
                ${resolution}
            ${maybe_returning}`
    },
    insert: sql_insert,
    insertMany<T extends {}, R extends Record<string, any> = {}>(table: string, values: readonly PartialOrFragments<T>[], returning: MaybeReturning<R> = sq`*`, onConflict = sq``) {
        if (values.length === 0) return sq`SELECT 1 WHERE 1 = 0` // return nothing (empty set)

        const keys = Object.keys(values[0])
        const inner_values = values.map(v => sq`(${sq.join(keys.map(k => sqlify_value(v[k]) ?? null), sq`, `)})`)
        const maybe_returning = (returning != null) ? sq`RETURNING ${returning}` : sq``
        return sq`
            INSERT INTO ${sq.identifier([table])}
                (${sq.join(Object.keys(values[0]).map(k => sq`${sq.identifier([k])}`), sq`, `)})
            VALUES
                ${sq.join(inner_values, sq`, `)}
                ${onConflict}
                ${maybe_returning}
        `
    },
    updateWhere<T>(table: string, value: PartialOrFragments<T>, where: PartialOrFragments<T>, returning: MaybeReturning = null) {
        const maybe_returning = (returning != null) ? sq`RETURNING ${returning}` : sq``
        return sq`
            UPDATE ${sq.identifier([table])}
            SET ${sql_fragments.updateSet(value)}
            WHERE ${sql_fragments.where(where)}
            ${maybe_returning}
        `
    },
    now() {
        return sq`NOW()`
    }
}

export type InsertableDate = string | ReturnType<typeof sql_addons.now>

export const sql_fragments = {
    updateSet<T extends {}>(value: T) {
        return sq.join(Object.keys(value).map(k => sq`${sq.identifier([k])} = ${sqlify_value(value[k])}`), sq`, `)
    },
    where<T extends {}>(where: T) {
        return sq.join(Object.keys(where).map(k => sq`${sq.identifier([k])} = ${where[k]}`), sq` AND `)
    }
}

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
    database: env.DB_NAME ?? 'nextjs_flash',
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


function instrumentQueries(pool: SaneSlonikPool) {
    const instrumentFunction = <T extends (query: Slonik.TaggedTemplateLiteralInvocation) => unknown>(func: T) => {
        return async (query: Slonik.TaggedTemplateLiteralInvocation) => {
            try {
                return await func(query)
            } catch (e: any) { // TODO: find out what error we're actually looking for
                const pos = +e.position
                console.error("Error when executing query: ")
                const lines = query.sql.split("\n")

                let char_counter = 0
                for (const line of lines) {
                    console.error(line)
                    if (pos >= char_counter && pos <= char_counter + line.length) {
                        console.error("--" + " ".repeat(pos - char_counter - 2) + "^  " + e.message)
                    }
                    char_counter += line.length + 1
                }

                throw e
            }
        }
    }

    const instrumentTransaction = (func: (cb: (tx: SaneSlonikTransaction) => Promise<unknown>) => Promise<unknown>) => {
        return (cb: (tx: SaneSlonikTransaction) => Promise<unknown>) => {
            return func(tx => cb(instrumentQueries(tx as any)))
        }
    }

    return Object.assign(pool, {
        any: instrumentFunction(pool.any),
        anyFirst: instrumentFunction(pool.anyFirst),
        maybeOne: instrumentFunction(pool.maybeOne),
        maybeOneFirst: instrumentFunction(pool.maybeOneFirst),
        one: instrumentFunction(pool.one),
        oneFirst: instrumentFunction(pool.oneFirst),
        query: instrumentFunction(pool.query),
        transaction: instrumentTransaction(pool.transaction),
        exists: instrumentFunction(pool.exists),
    }) as unknown as SaneSlonikPool
}

export const spool = await onceGlobally("/src/db.ts/spool", () => Slonik.createPool(
    `postgres://${env.DB_USERNAME ?? 'postgres'}:${env.DB_PASSWORD ?? ''}@${env.DB_HOST ?? '0.0.0.0'}:${env.DB_PORT ?? "5432"}/${env.DB_NAME ?? 'nextjs_flash'}`,
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
    .then(x => instrumentQueries(x as unknown as SaneSlonikPool))
    .catch(e => {
        console.error("Error when creating pool: ", e)
        return null
    }) as Promise<SaneSlonikPool>)

export const no_tx = spool as SaneSlonikTransaction

export const pool = onceGlobally("/src/db.ts/pool", () => new Pool({
    host: env.DB_HOST ?? '0.0.0.0',
    port: env.DB_PORT != null ? +env.DB_PORT : undefined,
    database: env.DB_NAME ?? 'nextjs_flash',
    user: env.DB_USERNAME ?? 'postgres',
    password: env.DB_PASSWORD ?? '',
    min: Number(env.DB_POOL_MIN),
    max: Number(env.DB_POOL_MAX ?? 30)
}))

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