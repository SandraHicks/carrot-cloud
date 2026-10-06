export type Merge<M, N> = Omit<M, Extract<keyof M, keyof N>> & N

export type Timestamp = number

export type Shuffle<T1, T2> = {
    [K in keyof T1]: K extends keyof T2 ? T1[K] | T2[K] : T1[K]
} & {
    [K in keyof T2]: K extends keyof T1 ? T1[K] | T2[K] : T2[K]
}

export type VeryPartial<T> = {
    [K in keyof T]?: T[K] | undefined
}

export type PartialWith<T, KS extends keyof T> = Partial<T> & Pick<T, KS>

export type Values<T> = T[keyof T]

export type MaybeOmit<T, KS extends keyof T> = Omit<T, KS> & Partial<T>

export type ID = number | string