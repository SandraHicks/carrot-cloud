

export * as Users from 'model/users'

export type UserRaw = {
    id: number
    username: string
    email: string
    password: string
    role_ids: number[]
}

export function get() {
    return null
}