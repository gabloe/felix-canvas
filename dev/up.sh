#!/usr/bin/env bash
# Start the development stack from scratch and wait for the broker. The
# control plane keeps its state in memory, so the broker's log is reset with
# it: a log that outlived its control plane would no longer match it.
#
# `--cluster` starts three replicating brokers instead of one
# (docker-compose.cluster.yml).
set -euo pipefail
cd "$(dirname "$0")"

# Docker or Podman: CONTAINER_ENGINE if set, else Docker when its daemon
# answers, else Podman.
engine="${CONTAINER_ENGINE:-}"
if [[ -z "$engine" ]]; then
  if docker info >/dev/null 2>&1; then
    engine=docker
  elif command -v podman >/dev/null 2>&1; then
    engine=podman
  else
    echo "no container engine: start Docker, or install Podman (and run podman machine start on macOS)" >&2
    exit 1
  fi
fi
compose=("$engine" compose)

files=(-f docker-compose.yml)
health=(8080)
if [[ "${1:-}" == "--cluster" ]]; then
  files+=(-f docker-compose.cluster.yml)
  health=(8080 8081 8082)
fi

"${compose[@]}" -f docker-compose.yml -f docker-compose.cluster.yml down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -f state/*.pem
mkdir -p state
if ! "${compose[@]}" "${files[@]}" up --detach; then
  "${compose[@]}" "${files[@]}" logs >&2
  exit 1
fi

ready() {
  for port in "${health[@]}"; do
    curl -fsS "http://127.0.0.1:$port/ready" >/dev/null 2>&1 || return 1
  done
}

# Every shard has a leader and all its copies, with none being added. A
# broker's /ready doesn't say this: the control plane places shards on the
# brokers that reported in first and adds the late one's copies afterwards,
# and until it has, stopping a broker can leave a shard without a majority.
replicated() {
  local body
  body="$(curl -fsS -H "authorization: Bearer $(cat state/node.token)" \
    http://127.0.0.1:8443/v1/placement/replication 2>/dev/null)" || return 1
  node -e '
    const { items } = JSON.parse(process.argv[1]);
    const done = (i) => i.leader && !i.under_replicated && !i.restoring && !i.unavailable?.length;
    if (items.length === 0 || !items.every(done)) process.exit(1);
    const copies = new Set(items.map((i) => i.current_replicas));
    console.log(`${items.length} shards placed, each with ${[...copies].join(" or ")} copies`);
  ' "$body"
}

waited=0
for _ in $(seq 1 90); do
  if ready; then
    if [[ ${#health[@]} -gt 1 ]]; then
      if ! replicated; then
        if ((waited++ == 0)); then echo "waiting for every shard to have all three copies"; fi
        sleep 2
        continue
      fi
      # Each broker signs its own certificate; trust all three.
      cat state/broker-*-cert.pem >state/broker-cert.pem
    fi
    echo "Felix is ready. For the gateway:"
    echo "  export GATEWAY_FELIX_CA_FILE=dev/state/broker-cert.pem"
    echo "  export GATEWAY_SCOPE_FILE=deploy/scope.toml"
    echo "  export GATEWAY_TENANT=canvas GATEWAY_OIDC_CLIENT_ID=felix-canvas"
    if [[ ${#health[@]} -gt 1 ]]; then
      echo "  export GATEWAY_FELIX_BROKERS=127.0.0.1:5000,127.0.0.1:5010,127.0.0.1:5020"
    fi
    echo "The snapshotter also takes"
    echo "  export CANVAS_FELIX_TOKEN=\"\$(cat dev/state/snapshotter.token)\""
    echo "The rooms service signs in on its own, with"
    echo "  export CANVAS_FELIX_CONTROL_PLANE=http://127.0.0.1:8443 CANVAS_SERVICE_IDP=http://127.0.0.1:9400"
    echo "  export CANVAS_INVITE_SECRET=\"\$(openssl rand -hex 24)\""
    exit 0
  fi
  sleep 2
done

echo "the brokers did not become ready" >&2
if [[ ${#health[@]} -gt 1 ]]; then
  curl -sS -H "authorization: Bearer $(cat state/node.token)" http://127.0.0.1:8443/v1/placement/replication >&2 || true
fi
"${compose[@]}" "${files[@]}" ps --all >&2
"${compose[@]}" "${files[@]}" logs >&2
exit 1
