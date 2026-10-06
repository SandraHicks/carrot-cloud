#!/bin/sh
set -eu pipefail

# check DB up and running
echo "Attempting to connect to DB"
until $(nc -zv $DB_HOST $DB_PORT); do
    printf '.'
    sleep 1s
done

# start app and wait for DB schema be initialized
echo "Was able to connect to DB, now starting app..."
npm run start
grep -q "DB initialized"