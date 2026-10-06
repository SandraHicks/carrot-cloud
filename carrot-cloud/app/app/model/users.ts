import { ID } from '../src/types'


export * as Users from './users'

export type UserRaw = {
    id: ID
    username: string
    email: string
    password: string
    role_ids: number[]
}

export function get() {
    return null
}