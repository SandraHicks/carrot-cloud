#!/bin/bash

if [[ "$OSTYPE" == "linux-"* ]]; then
    export DOCKER_USER="$(id -u):$(id -g)"
else
    export DOCKER_USER="0:0"
fi

docker-compose up $@ app