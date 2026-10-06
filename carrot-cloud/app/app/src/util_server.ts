
export function dbNow() {
    return (new Date).toISOString()
}

export function onceGlobally<T>(key: string, initFn: () => T) {
    if (process.env.NODE_ENV !== 'development') return initFn()

    const global = globalThis as typeof globalThis & Record<string, unknown>
    if (!(key in global)) {
        global[key] = initFn()
    }
    return global[key] as T
}