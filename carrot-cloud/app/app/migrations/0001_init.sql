CREATE TABLE IF NOT EXISTS users
(
    id SERIAL PRIMARY KEY,
    username VARCHAR(128) NOT NULL,
    email text NOT NULL,
    password VARCHAR(255) NOT NULL,
    role_ids INT[] NOT NULL DEFAULT '{}'
);