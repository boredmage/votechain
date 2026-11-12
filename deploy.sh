#!/usr/bin/env bash
#
# deploy.sh: deploy / update ClearCount on a VPS with Docker.
#
# Brings up the stack in docker-compose.prod.yml:
#   * clearcount-api          Express API (+ filtered chain RPC at /api/rpc)  -> api.<domain>
#   * clearcount-dashboard    nginx serving the React app                     -> dashboard.<domain>
#   * clearcount-prod-chain / -postgres / -deployer (/ -ipfs)  internal only, no public ports
# The API and the dashboard join the shared `web` network so the GLOBAL Caddy can reach them by name.
#
# Usage:
#   ./deploy.sh              # first run: ask for the domain and settings, then build + start;
#                            # later runs: rebuild + restart (the election on the chain is kept)
#   ./deploy.sh --pull       # git pull first, then build + restart
#   ./deploy.sh --logs       # after a successful deploy, tail the logs
#   ./deploy.sh setup        # re-run the setup questions (rewrites .env.prod, keeps the DB password)
#   ./deploy.sh caddy        # print the Caddyfile blocks for this domain
#   ./deploy.sh backup       # chain state, deployments, uploads + a pg_dump -> ./backups/<timestamp>.tar.gz
#   ./deploy.sh reset        # WIPE everything and start a fresh demo election (asks first)
#   ./deploy.sh rollback     # re-run the previous images (bad-deploy escape)
#   ./deploy.sh down         # stop + remove containers (chain, database and uploads are kept)
#
set -euo pipefail

# Always operate from the directory this script lives in (the repo root).
cd "$(dirname "$0")"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

ENV_FILE=.env.prod
API_CONTAINER=clearcount-api
WEB_CONTAINER=clearcount-dashboard
IMAGES="clearcount-api clearcount-dashboard clearcount-deployer"
VOLUMES="clearcount-prod-chain clearcount-prod-pg clearcount-prod-deployments clearcount-prod-uploads clearcount-prod-ipfs"

# --- Resolve the compose command (v2 plugin vs legacy v1) -------------------
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Docker Compose not found. Install Docker Engine + the compose plugin."
fi
COMPOSE="$COMPOSE -f docker-compose.prod.yml --env-file $ENV_FILE"

# --- Helpers ------------------------------------------------------------------
env_val() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' ; return 0; }

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 96 | tr -d '/+=\n' | cut -c1-"${1:-48}"
  else
    head -c 128 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-"${1:-48}"
  fi
}

# ask VAR "Prompt" "default": sets VAR from the answer, or the default on Enter.
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ -n "$__default" ]; then
    read -r -p "$__prompt [$__default]: " __reply || true
  else
    read -r -p "$__prompt: " __reply || true
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}
ask_required() {  # like ask, but keeps asking until there is an answer
  while :; do
    ask "$@"
    [ -n "${!1}" ] && return 0
    echo "  This one is needed."
  done
}
ask_hidden() {  # for secrets: no echo
  local __var="$1" __prompt="$2" __reply=""
  read -r -s -p "$__prompt: " __reply || true; echo
  printf -v "$__var" '%s' "$__reply"
}
strip_host() { local h="$1"; h="${h#https://}"; h="${h#http://}"; printf '%s' "${h%%/*}"; }
backup_file() { [ -f "$1" ] && cp "$1" "$1.bak.$(date +%Y%m%d-%H%M%S)" && warn "Previous $1 kept as $1.bak.*"; return 0; }
interactive() { [ -t 0 ] || [ "${DEPLOY_INTERACTIVE:-0}" = "1" ]; }
running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

api_host()  { strip_host "$(env_val PUBLIC_API_URL)"; }
dash_host() { strip_host "$(env_val DASHBOARD_URL)"; }

# The optional Kubo node is a compose profile; turn it on whenever .env.prod selects it.
[ "$(env_val IPFS_PROVIDER)" = "kubo" ] && export COMPOSE_PROFILES=ipfs

print_caddy() {
  cat <<EOF

    Add these to the global Caddyfile (Caddy must be on the 'web' network), then reload Caddy,
    e.g.  docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile

        $(api_host) {
            reverse_proxy $API_CONTAINER:4000
        }
        $(dash_host) {
            reverse_proxy $WEB_CONTAINER:80
        }

    Both hostnames need DNS A/AAAA records pointing at this server.
    The browser reaches the chain through https://$(api_host)/api/rpc (MetaMask's RPC URL too).

EOF
}

# --- Setup ----------------------------------------------------------------------
setup_env() {
  echo
  log "Setup: addresses and options ($ENV_FILE)"
  echo "    The API is served on api.<domain> and the dashboard on dashboard.<domain>."
  local domain api dash demo prefill ipfs pinata="" pinata_gw pg
  ask_required domain "Base domain (without https://, e.g. example.com)" "$(api_host | sed 's/^api\.//')"
  domain="$(strip_host "$domain")"
  ask api  "API hostname" "api.$domain"
  ask dash "Dashboard hostname" "dashboard.$domain"
  api="$(strip_host "$api")"; dash="$(strip_host "$dash")"

  echo
  echo "    Demo mode shows the role switcher: the API hands out the PUBLIC test-mnemonic keys of the"
  echo "    seeded stakeholders, so anyone with the link can act as any official. Right for a demo;"
  echo "    without it every stakeholder needs MetaMask with their seeded key imported."
  ask demo "Enable demo mode? (y/n)" "$( [ "$(env_val DEMO_MODE)" = "false" ] && echo n || echo y )"
  case "$demo" in [Nn]*) demo=false ;; *) demo=true ;; esac

  echo
  echo "    How far the demo election is pre-filled on first start: none | live | all | declared"
  ask prefill "Seed level" "$(env_val DEMO_PREFILL)"
  prefill="${prefill:-live}"
  case "$prefill" in none|live|all|declared) ;; lga) prefill=live ;; *) warn "Unknown seed level '$prefill', using live."; prefill=live ;; esac

  echo
  echo "    Where scanned result forms are stored: local (disk volume), pinata, or kubo (own IPFS node)"
  ask ipfs "IPFS provider" "$(env_val IPFS_PROVIDER)"
  ipfs="${ipfs:-local}"
  pinata_gw="$(env_val PINATA_GATEWAY_URL)"; pinata_gw="${pinata_gw:-https://gateway.pinata.cloud}"
  case "$ipfs" in
    pinata)
      pinata="$(env_val PINATA_JWT)"
      if [ -z "$pinata" ]; then ask_hidden pinata "Pinata JWT"; fi
      [ -n "$pinata" ] || { warn "No Pinata JWT: falling back to local."; ipfs=local; }
      ask pinata_gw "Pinata gateway URL" "$pinata_gw"
      ;;
    kubo|local) ;;
    *) warn "Unknown provider '$ipfs', using local."; ipfs=local ;;
  esac

  # Keep the existing password: PostgreSQL only reads it when the data volume is first created.
  pg="$(env_val POSTGRES_PASSWORD)"
  [ -n "$pg" ] || pg="$(gen_secret 40)"

  backup_file "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Written by deploy.sh for docker-compose.prod.yml. Edit by hand or re-run: ./deploy.sh setup
# Changing a URL or DEMO_MODE needs a rebuild (./deploy.sh): the dashboard bakes them in.

# Public https URLs the global Caddy serves
PUBLIC_API_URL=https://$api
DASHBOARD_URL=https://$dash

# Role switcher with the public test keys (see deploy.sh setup)
DEMO_MODE=$demo
# Seed level for the first start / after ./deploy.sh reset: none | live | all | declared
DEMO_PREFILL=$prefill

# local | pinata | kubo
IPFS_PROVIDER=$ipfs
PINATA_JWT=$pinata
PINATA_GATEWAY_URL=$pinata_gw

# Set on first setup; PostgreSQL keeps the one it was created with, so don't change it by hand.
POSTGRES_PASSWORD=$pg
EOF
  chmod 600 "$ENV_FILE"
  if [ "$ipfs" = "kubo" ]; then export COMPOSE_PROFILES=ipfs; else unset COMPOSE_PROFILES; fi
  log "Wrote $ENV_FILE (API https://$api, dashboard https://$dash)"
}

env_ok() {
  local api dash
  api="$(env_val PUBLIC_API_URL)"; dash="$(env_val DASHBOARD_URL)"
  case "$api"  in https://*) ;; *) return 1 ;; esac
  case "$dash" in https://*) ;; *) return 1 ;; esac
  [ -n "$(env_val POSTGRES_PASSWORD)" ]
}

# --- Health wait (shared by deploy and rollback) ---------------------------------
# No host ports, so probe from inside the containers: the API reports the chain reachable, the
# dashboard serves its page, and the dashboard reaches the API's RPC proxy by container name over
# `web` (the same path Caddy uses) and gets chain id 31337 (0x7a69) back.
wait_healthy() {
  log "Waiting for the API, the chain and the dashboard to answer..."
  local rpc='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
  for _ in $(seq 1 60); do
    if docker exec "$API_CONTAINER" wget -qO- http://127.0.0.1:4000/api/health 2>/dev/null | grep -q '"ok":true' \
       && docker exec "$WEB_CONTAINER" wget -q -O /dev/null http://127.0.0.1/ >/dev/null 2>&1 \
       && docker exec "$WEB_CONTAINER" wget -qO- --header 'Content-Type: application/json' --post-data "$rpc" \
            "http://$API_CONTAINER:4000/api/rpc" 2>/dev/null | grep -q 0x7a69; then
      log "API, chain and dashboard are up."
      return 0
    fi
    sleep 2
  done
  return 1
}

start_stack() {
  # `up` waits for the deployer job; if it fails, its log says why.
  if ! $COMPOSE up -d --remove-orphans "$@"; then
    warn "Starting the stack failed. Deployer log:"
    $COMPOSE logs --tail=60 deployer || true
    die "See above. Fix it, then run ./deploy.sh again."
  fi
}

# --- Subcommands ----------------------------------------------------------------
case "${1:-}" in
  down)
    log "Stopping the stack (chain, database and uploads are kept)..."
    $COMPOSE down
    exit 0
    ;;
  setup)
    interactive || die "setup needs a terminal to ask on."
    setup_env
    print_caddy
    log "Setup done. Deploy with: ./deploy.sh"
    exit 0
    ;;
  caddy)
    env_ok || die "Not set up yet: run ./deploy.sh setup"
    print_caddy
    exit 0
    ;;
  reset)
    env_ok || die "Not set up yet: run ./deploy.sh setup"
    interactive || die "reset needs a terminal to confirm on."
    warn "This DELETES the chain, the database, the uploaded forms and the deployment, then"
    warn "deploys fresh contracts and seeds a new demo election (seed level: $(env_val DEMO_PREFILL))."
    ask confirm "Type 'reset' to continue" ""
    [ "$confirm" = "reset" ] || die "Cancelled."
    $COMPOSE down -v
    log "Starting a fresh election..."
    start_stack
    wait_healthy || { $COMPOSE logs --tail=50; die "Reset done but the health check failed."; }
    $COMPOSE ps
    exit 0
    ;;
  backup)
    docker volume inspect clearcount-prod-chain >/dev/null 2>&1 || die "No clearcount-prod-chain volume yet: nothing to back up."
    stamp="$(date +%Y%m%d-%H%M%S)"
    work="backups/clearcount-$stamp"
    mkdir -p "$work"
    log "Backing up to backups/clearcount-$stamp.tar.gz ..."
    # The chain state is the source of truth; PostgreSQL is a cache the indexer can rebuild, but
    # a dump makes restoring quicker.
    if running clearcount-prod-postgres; then
      docker exec clearcount-prod-postgres pg_dump -U clearcount clearcount > "$work/postgres.sql"
    else
      warn "PostgreSQL is not running: no database dump (the indexer rebuilds it from the chain)."
    fi
    for vol in clearcount-prod-chain clearcount-prod-deployments clearcount-prod-uploads; do
      docker run --rm -v "$vol":/data:ro -v "$PWD/$work":/out alpine tar czf "/out/$vol.tar.gz" -C /data .
    done
    tar czf "backups/clearcount-$stamp.tar.gz" -C backups "clearcount-$stamp" && rm -rf "$work"
    chmod 600 "backups/clearcount-$stamp.tar.gz"
    log "Done: backups/clearcount-$stamp.tar.gz"
    exit 0
    ;;
  rollback)
    env_ok || die "Not set up yet: run ./deploy.sh setup"
    for img in $IMAGES; do
      docker image inspect "$img:previous" >/dev/null 2>&1 \
        || die "No $img:previous image: nothing to roll back to."
    done
    log "Rolling back to the previous images..."
    for img in $IMAGES; do docker tag "$img:previous" "$img:latest"; done
    start_stack --no-build
    wait_healthy || { $COMPOSE logs --tail=50; die "Rollback started but the health check failed."; }
    $COMPOSE ps
    exit 0
    ;;
esac

# --- Parse flags ------------------------------------------------------------
PULL=0
TAIL=0
for arg in "$@"; do
  case "$arg" in
    --pull) PULL=1 ;;
    --logs) TAIL=1 ;;
    *) warn "ignoring unknown argument: $arg" ;;
  esac
done

# --- Optionally pull the latest code ----------------------------------------
if [ "$PULL" -eq 1 ]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    log "Pulling latest code..."
    before="$(git rev-parse HEAD)"
    git pull --ff-only
    # Bash reads a script incrementally, so a pull that rewrites THIS file mid-run would execute
    # a mix of both versions. Re-exec the pulled version, at most once.
    if [ "$(git rev-parse HEAD)" != "$before" ] && [ "${DEPLOY_REEXEC:-0}" != "1" ]; then
      log "Code changed: restarting deploy.sh so this deploy runs one version..."
      args=(); for a in "$@"; do [ "$a" = "--pull" ] || args+=("$a"); done
      DEPLOY_REEXEC=1 exec "$0" ${args[@]+"${args[@]}"}
    fi
  else
    warn "--pull requested but this isn't a git checkout; skipping."
  fi
fi

# --- First-run setup ------------------------------------------------------------
FIRST_RUN=0
if ! env_ok; then
  interactive || die "Not set up yet and no terminal to ask on. Run ./deploy.sh setup interactively."
  setup_env
  FIRST_RUN=1
fi

# --- Preflight ----------------------------------------------------------------
docker network inspect web >/dev/null 2>&1 \
  || die "Docker network 'web' does not exist. It is the network your global Caddy is on: docker network create web"

if [ "$(env_val IPFS_PROVIDER)" = "pinata" ] && [ -z "$(env_val PINATA_JWT)" ]; then
  die "IPFS_PROVIDER=pinata needs PINATA_JWT in $ENV_FILE (or run ./deploy.sh setup)."
fi

# --- Build & start ----------------------------------------------------------
# Keep the running images as :previous so `./deploy.sh rollback` can restore them.
for img in $IMAGES; do
  if docker image inspect "$img:latest" >/dev/null 2>&1; then
    docker tag "$img:latest" "$img:previous"
  fi
done

log "Building images (contracts, API, and the dashboard against $(env_val PUBLIC_API_URL))..."
$COMPOSE build

log "Starting the stack (the first start deploys the contracts and seeds the election)..."
start_stack

# --- Wait for the site to answer ----------------------------------------------
if wait_healthy; then
  $COMPOSE ps
  [ "$FIRST_RUN" = "1" ] && print_caddy
  log "API:       $(env_val PUBLIC_API_URL)/api/health"
  log "Dashboard: $(env_val DASHBOARD_URL)"
  if [ "$TAIL" -eq 1 ]; then
    exec $COMPOSE logs -f
  fi
  exit 0
fi

warn "The stack did not become healthy within ~2 minutes. Recent logs:"
$COMPOSE logs --tail=50
die "Deployment failed the health check: roll back with ./deploy.sh rollback"
