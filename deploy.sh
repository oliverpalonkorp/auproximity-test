#!/bin/bash
set -euo pipefail

# NOTE: select your desired commit in advance using Git

# Build backend
yarn
yarn build

# Build frontend
pushd auproximity-webui
yarn
# NOTE: because the frontend is served by Nginx, this immediately sets the new frontend live
yarn build
popd

# Restart the backend
pm2 reload 0