export function onceGlobally<T>(key: string, initFn: () => T) {
    if (process.env.NODE_ENV !== 'development') return initFn()

    if (global[key] === undefined) {
        global[key] = initFn()
    }
    return global[key] as T
}